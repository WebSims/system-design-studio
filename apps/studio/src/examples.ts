import { STUDY_EXAMPLES, type StudyExample } from "@sds/models";
import { StudySchema, type Study } from "@sds/schema";

/**
 * Worked scenarios, offered on the first-run screen.
 *
 * AN EXAMPLE, NOT A DEFAULT
 *
 * The studio still boots into an empty project and "new project" is still blank. What changed is
 * that a person can OPT IN to a bundled scenario from the start screen, because a race condition
 * you can watch happen in the first minute is worth more than any amount of prompt text about
 * one. The scenario opens as a fresh copy with its own id, so it is a project like any other:
 * editable, deletable, and never mistaken for the retired demo record older builds persisted.
 */
export interface DemoScenario {
  id: string;
  label: string;
  summary: string;
  teaches: string;
  open(): Study;
}

const asScenario = (example: StudyExample): DemoScenario => ({
  id: example.id,
  label: example.label,
  summary: example.summary,
  teaches: example.teaches,
  open: () => {
    const built = example.build();
    return StudySchema.parse({
      ...built,
      // A fresh id per open. The bundled id is retired in persistence so an upgrade cannot resurrect
      // the old auto-loaded demo, and a copy must not collide with it.
      id: `demo-${example.id}-${Date.now().toString(36)}`,
      updatedAt: Date.now(),
    });
  },
});

export const DEMO_SCENARIOS: readonly DemoScenario[] = STUDY_EXAMPLES.map(asScenario);
