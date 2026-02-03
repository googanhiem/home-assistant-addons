import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { schedulesFile, outputDir } from "./const.js";

export class Scheduler {
  constructor(requestHandler) {
    this.requestHandler = requestHandler;
    this.schedules = {};
    this.intervals = {};

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Ensure data directory exists (for local dev)
    const dataDir = schedulesFile.substring(0, schedulesFile.lastIndexOf("/"));
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    this.load();
  }

  load() {
    try {
      if (existsSync(schedulesFile)) {
        this.schedules = JSON.parse(readFileSync(schedulesFile, "utf-8"));
        // Restart timers
        for (const [id, schedule] of Object.entries(this.schedules)) {
          this.startTimer(id, schedule);
        }
        console.log(`Loaded ${Object.keys(this.schedules).length} schedules.`);
      }
    } catch (err) {
      console.error("Failed to load schedules:", err);
      this.schedules = {};
    }
  }

  save() {
    try {
      writeFileSync(schedulesFile, JSON.stringify(this.schedules, null, 2));
    } catch (err) {
      console.error("Failed to save schedules:", err);
    }
  }

  add(schedule) {
    const id = Date.now().toString();
    this.schedules[id] = { 
        ...schedule, 
        id, 
        created: Date.now(),
        // Sanitize filename
        filename: schedule.filename.replace(/[^a-z0-9\-_]/gi, '_') 
    };
    this.save();
    this.startTimer(id, this.schedules[id]);
    
    // Execute immediately so user sees result
    this.execute(id);
    
    return this.schedules[id];
  }

  delete(id) {
    if (this.schedules[id]) {
      this.stopTimer(id);
      delete this.schedules[id];
      this.save();
      return true;
    }
    return false;
  }

  list() {
    return Object.values(this.schedules).sort((a, b) => b.created - a.created);
  }

  startTimer(id, schedule) {
    this.stopTimer(id);
    const intervalMs = schedule.interval * 60 * 1000;
    
    if (intervalMs > 0) {
        this.intervals[id] = setInterval(() => this.execute(id), intervalMs);
        console.log(`Started schedule ${id} (${schedule.filename}) every ${schedule.interval} minutes.`);
    }
  }

  stopTimer(id) {
    if (this.intervals[id]) {
      clearInterval(this.intervals[id]);
      delete this.intervals[id];
    }
  }

  async execute(id) {
    const schedule = this.schedules[id];
    if (!schedule) return;

    console.log(`Executing schedule: ${schedule.filename} (${id})`);
    
    try {
      // Parse color strings into arrays (same processing as parseRequestParams)
      const params = { ...schedule.params };
      
      if (typeof params.colors === 'string') {
        params.colors = params.colors
          .split(",")
          .map((color) => color.trim())
          .map((color) => color.startsWith("#") ? color : `#${color}`)
          .filter((color) => /^#[0-9A-F]{6}$/i.test(color));
      }
      
      if (typeof params.paletteColors === 'string') {
        params.paletteColors = params.paletteColors
          .split(",")
          .map((color) => color.trim())
          .map((color) => color.startsWith("#") ? color : `#${color}`)
          .filter((color) => /^#[0-9A-F]{6}$/i.test(color));
      }
      
      // Ensure paletteColors defaults to colors if empty (same logic as parseRequestParams)
      if (params.paletteColors?.length === 0 && params.colors?.length > 0) {
        params.paletteColors = params.colors;
      }
      
      // Use the RequestHandler to take the screenshot
      // This ensures we respect the queue and browser state
      const result = await this.requestHandler.processScreenshot(params);
      
      const extension = schedule.params.format || 'png';
      const filename = `${schedule.filename}.${extension}`;
      const filePath = join(outputDir, filename);
      
      writeFileSync(filePath, result.image);
      console.log(`Saved scheduled screenshot to ${filePath}`);
    } catch (err) {
      console.error(`Error executing schedule ${id}:`, err);
    }
  }
}
