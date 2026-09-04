import { describe, expect, it } from "vitest"
import { INTERVIEW_PROMPTS, PIZZA_INTERVIEW_PROMPT } from "../src/interview-prompts"

const EXPECTED_PIZZA_PROMPT =
  "Use System Design Studio's studio_* WebMCP site tools on this page to create a fresh project for this system-design interview: design a launch-day giveaway for 200 free pizzas—first come, first served, one per person, and never oversell. Thousands may arrive at once, retry, or double-click. Explore and test your design in the Studio, then recommend the best option under your assumptions, favoring correctness and simplicity. Explain the request flow, bottleneck and scaling limits, trade-offs, failure modes, and other risks."

describe("starter interview prompts", () => {
  it("keeps the pizza prompt exact, short and available from the starter registry", () => {
    expect(PIZZA_INTERVIEW_PROMPT).toBe(EXPECTED_PIZZA_PROMPT)
    expect(PIZZA_INTERVIEW_PROMPT.split(/\s+/).length).toBeLessThanOrEqual(80)
    expect(INTERVIEW_PROMPTS).toEqual([
      expect.objectContaining({
        id: "two-hundred-free-pizzas",
        label: "200 free pizzas",
        prompt: PIZZA_INTERVIEW_PROMPT,
      }),
    ])
  })

  it("asks for the scenario, analysis and interview answer without prescribing the solution", () => {
    expect(PIZZA_INTERVIEW_PROMPT).toMatch(/one per person, and never oversell/)
    expect(PIZZA_INTERVIEW_PROMPT).toMatch(/Thousands may arrive at once, retry, or double-click/)
    expect(PIZZA_INTERVIEW_PROMPT).toMatch(/studio_\* WebMCP site tools on this page/)
    expect(PIZZA_INTERVIEW_PROMPT).toMatch(/Explore and test your design in the Studio/)
    expect(PIZZA_INTERVIEW_PROMPT).toMatch(/best option under your assumptions, favoring correctness and simplicity/)
    expect(PIZZA_INTERVIEW_PROMPT).toMatch(/bottleneck and scaling limits, trade-offs, failure modes, and other risks/)
    expect(PIZZA_INTERVIEW_PROMPT).not.toMatch(/candidate|transaction|database|queue|lock|redis|postgres/i)
  })
})
