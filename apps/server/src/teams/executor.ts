// TeamExecutor — dispatches to the correct collaboration mode executor
import type { TeamDefinition, TeamStreamEvent } from "@agentforge/shared-types";
import { DiagnosisMode } from "./modes/diagnosis.js";
import type {
  CollaborationModeExecutor,
  ExecutionContext,
} from "./modes/types.js";

export class TeamExecutor {
  private modeExecutors: Map<string, CollaborationModeExecutor>;

  constructor() {
    this.modeExecutors = new Map([
      ["diagnosis", new DiagnosisMode()],
    ]);
  }

  async *execute(
    definition: TeamDefinition,
    task: string,
    context: ExecutionContext,
  ): AsyncGenerator<TeamStreamEvent> {
    const mode = definition.collaborationMode;
    const executor = this.modeExecutors.get(mode);

    if (!executor) {
      yield {
        type: "team_failed",
        error: `Unknown collaboration mode: ${mode}`,
      };
      return;
    }

    // Validate team before execution
    const errors = this.validateTeam(definition);
    if (errors.length > 0) {
      yield {
        type: "team_failed",
        error: `Team validation failed: ${errors.join("; ")}`,
      };
      return;
    }

    // Delegate to mode executor
    yield* executor.execute(definition, task, context);
  }

  private validateTeam(definition: TeamDefinition): string[] {
    const errors: string[] = [];

    if (!definition.agents || definition.agents.length < 2) {
      errors.push("Team must have at least 2 agents");
    }

    if (definition.agents.length > 10) {
      errors.push("Team cannot have more than 10 agents");
    }

    // Check unique names
    const names = definition.agents.map((a) => a.name);
    if (new Set(names).size !== names.length) {
      errors.push("Agent names must be unique");
    }

    // Mode-specific validation
    if (definition.collaborationMode === "diagnosis") {
      if (!names.includes("frontend_agent")) {
        errors.push(
          "Diagnosis mode requires an agent named 'frontend_agent'",
        );
      }
    }

    return errors;
  }
}
