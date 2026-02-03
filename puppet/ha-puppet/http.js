import http from "node:http";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { Browser } from "./screenshot.js";
import { isAddOn, hassUrl, hassToken, keepBrowserOpen, outputDir } from "./const.js";
import { CannotOpenPageError } from "./error.js";
import { handleUIRequest } from "./ui.js";
import { loadDevicesConfig, getDeviceConfig } from "./devices.js";
import { Scheduler } from "./scheduler.js";

// Maximum number of next requests to keep in memory
const MAX_NEXT_REQUESTS = 100;
const BROWSER_TIMEOUT = 30_000; // Timeout for browser inactivity in milliseconds

class RequestHandler {
  constructor(browser) {
    this.browser = browser;
    this.busy = false;

    // Pending web requests
    this.pending = [];

    // Request counter to identify requests
    this.requestCount = 0;

    // Timeout identifiers for next requests
    this.nextRequests = [];

    // Time it takes to navigate to a page
    this.navigationTime = 0;

    // Last time the browser was accessed
    this.lastAccess = new Date();
  }

  _runBrowserCleanupCheck = async () => {
    if (this.busy) {
      return;
    }

    const idleTime = Date.now() - this.lastAccess.getTime();

    if (idleTime < BROWSER_TIMEOUT) {
      // Not time to clean up yet. Reschedule for the remaining time.
      const remainingTime = BROWSER_TIMEOUT - idleTime;
      this.browserCleanupTimer = setTimeout(
        this._runBrowserCleanupCheck,
        remainingTime + 100,
      );
      return;
    }

    await this.browser.cleanup();
  };

  _markBrowserAccessed() {
    clearTimeout(this.browserCleanupTimer);
    this.lastAccess = new Date();
    if (keepBrowserOpen) {
      return;
    }
    this.browserCleanupTimer = setTimeout(
      this._runBrowserCleanupCheck,
      BROWSER_TIMEOUT + 100,
    );
  }

  /**
   * Internal method to process a screenshot request
   * This is used by both the HTTP handler and the Scheduler
   */
  async processScreenshot(params, requestId = "internal") {
    const start = new Date();
    
    // Queue logic
    if (this.busy) {
      console.log(requestId, "Busy, waiting in queue");
      await new Promise((resolve) => this.pending.push(resolve));
      const end = Date.now();
      console.log(requestId, `Wait time: ${end - start} ms`);
    }
    this.busy = true;

    try {
      console.debug(requestId, "Processing screenshot", params.pagePath);

      // Extract next param to handle it separately from the main flow
      // (The scheduler doesn't strictly need 'next' logic in the same way, but good to preserve)
      const next = params.next; 

      let navigateResult = null;
      try {
        navigateResult = await this.browser.navigatePage(params);
      } catch (err) {
        if (err instanceof CannotOpenPageError) {
          throw err;
        }
        throw err;
      }
      
      console.debug(requestId, `Navigated in ${navigateResult.time} ms`);
      this.navigationTime = Math.max(this.navigationTime, navigateResult.time);
      
      const screenshotResult = await this.browser.screenshotPage(params);
      console.debug(requestId, `Screenshot in ${screenshotResult.time} ms`);
      
      return {
        image: screenshotResult.image,
        timing: {
            start,
            navigationTime: this.navigationTime
        },
        next
      };

    } finally {
      this.busy = false;
      const resolve = this.pending.shift();
      if (resolve) {
        resolve();
      }
      this._markBrowserAccessed();
    }
  }

  async parseRequestParams(requestUrl) {
    // Load device configurations
    const devicesData = loadDevicesConfig();

    // Check for device parameter and apply device configuration
    const deviceParam = requestUrl.searchParams.get("device");
    let deviceConfig = null;
    if (deviceParam) {
      deviceConfig = getDeviceConfig(deviceParam, devicesData);
      if (!deviceConfig) {
        throw new Error(`Unknown device: ${deviceParam}`);
      }
    }

    let extraWait = parseInt(requestUrl.searchParams.get("wait"));
    if (isNaN(extraWait)) {
      extraWait = undefined;
    }

    // Get viewport
    let viewportParams;
    const viewportQuery = requestUrl.searchParams.get("viewport");
    if (viewportQuery) {
      viewportParams = viewportQuery.split("x").map((n) => parseInt(n));
    } else if (deviceConfig) {
      viewportParams = [deviceConfig.width, deviceConfig.height];
    } else {
      viewportParams = [];
    }

    if (
      viewportParams.length != 2 ||
      !viewportParams.every((x) => !isNaN(x))
    ) {
      throw new Error("Invalid viewport");
    }

    let einkColors = parseInt(requestUrl.searchParams.get("eink"));
    if (isNaN(einkColors) || einkColors < 2) {
      einkColors = undefined;
    }

    const colorsQuery = requestUrl.searchParams.get("colors");
    const colorsString = colorsQuery !== null ? colorsQuery : (deviceConfig?.colors || "");
    let colors = colorsString
      .split(",")
      .map((color) => color.trim())
      .map((color) => color.startsWith("#") ? color : `#${color}`)
      .filter((color) => /^#[0-9A-F]{6}$/i.test(color));

    const paletteColorsQuery = requestUrl.searchParams.get("palette_colors");
    const paletteColorsString = paletteColorsQuery !== null ? paletteColorsQuery : (deviceConfig?.palette_colors || "");
    let paletteColors = paletteColorsString
      .split(",")
      .map((color) => color.trim())
      .map((color) => color.startsWith("#") ? color : `#${color}`)
      .filter((color) => /^#[0-9A-F]{6}$/i.test(color));

    if (colors.length > 0 && paletteColors.length > 0 && colors.length !== paletteColors.length) {
      paletteColors = [];
    }

    if (einkColors !== undefined) {
      if (einkColors === 2 && colors.length === 0) {
        colors = ["#000000", "#FFFFFF"];
      } else if (colors.length > 0) {
        einkColors = undefined;
      }
    }

    if (paletteColors.length === 0 && colors.length > 0) {
      paletteColors = colors;
    }

    let zoom = parseFloat(requestUrl.searchParams.get("zoom"));
    if (isNaN(zoom) || zoom <= 0) {
      zoom = 1;
    }

    const invert = requestUrl.searchParams.has("invert");

    let format = requestUrl.searchParams.get("format") || "png";
    if (!["png", "jpeg", "webp", "bmp"].includes(format)) {
      format = "png";
    }

    let bmpMode = requestUrl.searchParams.get("bmp_mode") || "color";
    if (!["color", "grayscale", "binary"].includes(bmpMode)) {
      bmpMode = "color";
    }

    let rotate = parseInt(requestUrl.searchParams.get("rotate"));
    if (isNaN(rotate) || ![90, 180, 270].includes(rotate)) {
      rotate = undefined;
    }

    const lang = requestUrl.searchParams.get("lang") || undefined;
    const theme = requestUrl.searchParams.get("theme") || undefined;
    const dark = requestUrl.searchParams.has("dark");
    
    const ditheringQuery = requestUrl.searchParams.get("dithering");
    let dithering = ditheringQuery !== null ? ditheringQuery : (deviceConfig?.dithering || "none");
    
    // next param
    const nextParam = requestUrl.searchParams.get("next");
    let next = parseInt(nextParam);
    if (isNaN(next) || next < 0) {
      next = undefined;
    }

    return {
      pagePath: requestUrl.pathname,
      viewport: { width: viewportParams[0], height: viewportParams[1] },
      extraWait,
      colors,
      paletteColors,
      dithering,
      invert,
      zoom,
      format,
      bmpMode,
      rotate,
      lang,
      theme,
      dark,
      next
    };
  }

  async handleRequest(request, response, scheduler) {
    const requestUrl = new URL(request.url, "http://localhost");

    // Serve static files from output directory
    if (requestUrl.pathname.startsWith("/output/")) {
        const filename = requestUrl.pathname.replace("/output/", "");
        // Basic path traversal protection
        if (filename.includes("..") || filename.includes("/")) {
            response.statusCode = 403;
            response.end("Forbidden");
            return;
        }
        
        const filePath = join(outputDir, filename);
        if (existsSync(filePath)) {
            const content = readFileSync(filePath);
            const ext = filename.split('.').pop();
            const mimeTypes = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                webp: 'image/webp',
                bmp: 'image/bmp'
            };
            response.writeHead(200, { 
                "Content-Type": mimeTypes[ext] || "application/octet-stream",
                "Content-Length": content.length
            });
            response.write(content);
            response.end();
            return;
        } else {
            response.statusCode = 404;
            response.end("File not found");
            return;
        }
    }

    // API: List Schedules
    if (requestUrl.pathname === "/api/schedules" && request.method === "GET") {
        const schedules = scheduler.list();
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(schedules));
        return;
    }

    // API: Create Schedule
    if (requestUrl.pathname === "/api/schedules" && request.method === "POST") {
        let body = "";
        request.on("data", chunk => body += chunk.toString());
        request.on("end", () => {
            try {
                const data = JSON.parse(body);
                // Validate required fields
                if (!data.filename || !data.interval || !data.params) {
                    response.statusCode = 400;
                    response.end("Missing required fields");
                    return;
                }
                const schedule = scheduler.add(data);
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(schedule));
            } catch (e) {
                console.error("Error creating schedule:", e);
                response.statusCode = 500;
                response.end("Internal Server Error");
            }
        });
        return;
    }

    // API: Delete Schedule
    if (requestUrl.pathname.startsWith("/api/schedules/") && request.method === "DELETE") {
        const id = requestUrl.pathname.split("/").pop();
        const success = scheduler.delete(id);
        if (success) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ success: true }));
        } else {
            response.statusCode = 404;
            response.end("Schedule not found");
        }
        return;
    }

    if (requestUrl.pathname === "/favicon.ico") {
      response.statusCode = 404;
      response.end();
      return;
    }

    if (requestUrl.pathname === "/") {
      await handleUIRequest(response);
      return;
    }

    const requestId = ++this.requestCount;
    
    try {
      let requestParams;
      try {
        requestParams = await this.parseRequestParams(requestUrl);
      } catch (e) {
        response.statusCode = 400;
        response.end(e.message);
        return;
      }

      // Use the internal process method
      let result;
      try {
        result = await this.processScreenshot(requestParams, requestId);
      } catch (err) {
        if (err instanceof CannotOpenPageError) {
          console.error(requestId, `Cannot open page: ${err.message}`);
          response.statusCode = 404;
          response.end(`Cannot open page: ${err.message}`);
          return;
        }
        throw err;
      }

      const { image, timing, next } = result;

      let contentType;
      if (requestParams.format === "jpeg") {
        contentType = "image/jpeg";
      } else if (requestParams.format === "webp") {
        contentType = "image/webp";
      } else if (requestParams.format === "bmp") {
        contentType = "image/bmp";
      } else {
        contentType = "image/png";
      }

      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": image.length,
      });
      response.write(image);
      response.end();

      if (!next) {
        return;
      }

      // Schedule next request (warmup)
      const end = new Date();
      const requestTime = end.getTime() - timing.start.getTime();
      const nextWaitTime =
        next * 1000 -
        requestTime -
        timing.navigationTime -
        1000;

      if (nextWaitTime < 0) {
        return;
      }
      console.debug(requestId, `Next request in ${nextWaitTime} ms`);
      this.nextRequests.push(
        setTimeout(
          () => this.prepareNextRequest(requestId, requestParams),
          nextWaitTime,
        ),
      );
      if (this.nextRequests.length > MAX_NEXT_REQUESTS) {
        clearTimeout(this.nextRequests.shift());
      }
    } catch (err) {
      console.error(requestId, "Unhandled error", err);
      if (!response.writableEnded) {
        response.statusCode = 500;
        response.end("Internal Server Error");
      }
    }
  }

  async prepareNextRequest(requestId, requestParams) {
    if (this.busy) {
      console.log("Busy, skipping next request");
      return;
    }
    requestId = `${requestId}-next`;
    this.busy = true;
    console.log(requestId, "Preparing next request");
    try {
      const navigateResult = await this.browser.navigatePage({
        ...requestParams,
        // No unnecessary wait time, as we're just warming up
        extraWait: 0,
      });
      console.debug(requestId, `Navigated in ${navigateResult.time} ms`);
    } catch (err) {
      console.error(requestId, "Error preparing next request", err);
    } finally {
      this.busy = false;
      const resolve = this.pending.shift();
      if (resolve) {
        resolve();
      }
      this._markBrowserAccessed();
    }
  }
}

const browser = new Browser(hassUrl, hassToken);
const requestHandler = new RequestHandler(browser);
const scheduler = new Scheduler(requestHandler); // Init scheduler
const port = 10000;

const server = http.createServer((request, response) =>
  requestHandler.handleRequest(request, response, scheduler),
);
server.listen(port);
const now = new Date();
const serverUrl = isAddOn
  ? `http://homeassistant.local:${port}`
  : `http://localhost:${port}`;
console.log(`[${now.toLocaleTimeString()}] Visit server at ${serverUrl}`);
