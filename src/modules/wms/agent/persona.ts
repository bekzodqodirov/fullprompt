/**
 * Who the AI is, and what it calls the person above it (stage 1a P3, docs/ai-toliq/qurish/STAGE-0-1A.md §4.4, §6.1).
 *
 * The persona is «GSR sotuv menejeri <ism>» — the name is HIS setting (`agent_persona_name`, settings/service
 * `readAgentPersonaName`), never a string here: design §11.2 and the build contract §4 name nobody in code.
 *
 * The person who approves, answers the AI's questions and gives the avia address is called by his POSITION in every
 * text the model reads and every line it writes — ONE word, exported here and interpolated at every site (prompt.ts,
 * tools.ts, owner-answer.ts, lessons.ts, lesson-rules.ts, policy.ts; `tests/unit/agent-persona.test.ts` counts the
 * sites with TypeScript's parser). His own name was written into eighteen strings: left there, a persona that carries
 * his name would read «ask <name>» as asking itself, and a persona with any other name would still be told it writes
 * «from <name>'s account». PURE, no imports: the prompt, the tools and the policy all read it.
 */

/** The owner's position, as the model and the card say it — Uzbek, lower case, with Uzbek's own case endings after it. */
export const OWNER_WORD = 'rahbar';

/** The persona's own words, for the one exemption the colleague-name check makes for them (policy `staffNameHits`). */
export function personaWordsOf(name: string): string[] {
  return name
    .trim()
    .split(/\s+/u)
    .filter((w) => w !== '');
}
