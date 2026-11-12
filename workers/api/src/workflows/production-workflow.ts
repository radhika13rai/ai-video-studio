import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";

/** Input to a production run. Grows in Task 7 as the agents are connected. */
export interface ProductionParams {
  projectId: string;
}

export interface ProductionResult {
  projectId: string;
  status: "not_implemented";
  message: string;
}

/**
 * Registered so the binding, local development and deployment work end to end.
 * It deliberately does no production work yet: the real steps (plan, storyboard, assets,
 * render request, quality control) are implemented in Task 7, and nothing calls this yet.
 */
export class ProductionWorkflow extends WorkflowEntrypoint<Env, ProductionParams> {
  override async run(
    event: WorkflowEvent<ProductionParams>,
    step: WorkflowStep,
  ): Promise<ProductionResult> {
    const projectId = await step.do("validate-input", async () => {
      if (!event.payload?.projectId) throw new Error("projectId is required");
      return event.payload.projectId;
    });
    return {
      projectId,
      status: "not_implemented",
      message: "Production steps are implemented in Task 7.",
    };
  }
}
