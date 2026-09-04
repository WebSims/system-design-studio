/**
 * Short, human-readable prompts offered from the Projects home.
 *
 * These describe the outcome and leave the design process to the agent. They do not contain
 * tool-call recipes, preferred technologies, or a prebuilt project hidden behind the card.
 */
export interface InterviewPrompt {
  readonly id: string
  readonly label: string
  readonly summary: string
  readonly prompt: string
}

export const PIZZA_INTERVIEW_PROMPT =
  "Use System Design Studio's studio_* WebMCP site tools on this page to create a fresh project for this system-design interview: design a launch-day giveaway for 200 free pizzas—first come, first served, one per person, and never oversell. Thousands may arrive at once, retry, or double-click. Explore and test your design in the Studio, then recommend the best option under your assumptions, favoring correctness and simplicity. Explain the request flow, bottleneck and scaling limits, trade-offs, failure modes, and other risks."

export const INTERVIEW_PROMPTS: readonly InterviewPrompt[] = [
  {
    id: "two-hundred-free-pizzas",
    label: "200 free pizzas",
    summary: "Design a fair, race-safe giveaway under a launch-day rush, then explain the bottleneck and trade-offs.",
    prompt: PIZZA_INTERVIEW_PROMPT,
  },
]
