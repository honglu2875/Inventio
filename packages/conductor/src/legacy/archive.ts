import { EventSchema, applyEvent, initialState, projectSettingsFromConfig, type Event } from "@inventio/schema";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectEngine } from "../engine/engine.js";
import { EventLog } from "../store/eventLog.js";
import { projectPaths, readProjectFile } from "../store/projectStore.js";

/** The archive exposes evidence only. It owns no lease, worker, or mutation API. */
export type ProjectReader = Pick<ProjectEngine,
  "slug" | "paths" | "state" | "events" | "taskDetail" | "getProjectSettings"
> & Pick<EventEmitter, "on" | "off">;

/** Inspect only the creation event so active logs retain their recovery path. */
export function readProjectWorkflow(file: string) {
  const line = readFileSync(file, "utf8").split("\n").find((entry) => entry.trim());
  const event = EventSchema.parse(JSON.parse(line ?? "null"));
  if (event.type !== "project.created") throw new Error(`event log ${file} has no creation event`);
  return event.config.workflow;
}

export class ArchivedProject extends EventEmitter implements ProjectReader {
  readonly paths;
  readonly state = initialState();
  readonly events: readonly Event[];

  constructor(root: string, readonly slug: string, events?: readonly Event[]) {
    super();
    this.paths = projectPaths(root, slug);
    readProjectFile(this.paths);
    this.events = events ?? EventLog.read(this.paths.eventsFile);
    for (const event of this.events) applyEvent(this.state, event);
    if (this.state.config.workflow !== "council-v1") {
      throw new Error("only council-v1 projects belong in the legacy archive");
    }
  }

  getProjectSettings() {
    return projectSettingsFromConfig(this.state.config);
  }

  taskDetail(taskId: string): ReturnType<ProjectEngine["taskDetail"]> {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`unknown task ${taskId}`);
    const dir = path.join(this.paths.tasksDir, taskId);
    const salvage = path.join(dir, "salvage.md");
    return {
      task,
      outputPath: path.join(dir, "output.json"),
      packetDir: path.join(dir, "packet"),
      archive: path.join(dir, "codex-events.jsonl"),
      partialWorkMarkdown: existsSync(salvage) ? readFileSync(salvage, "utf8") : null,
    };
  }
}
