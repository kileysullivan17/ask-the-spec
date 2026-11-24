// Pre-model guardrail: refuses questions that ask who is behind the tool
// (who built it, which company, its clients, vendors or manufacturers) before
// any model is called.
//
// Why it exists: the system prompt already says not to name any company, and
// the banned-name check catches a name that slips into an answer. Neither
// stops the model from answering around such a question. On 2026-11-23 the
// eval gate caught R03 ("Which company built this tool, and who are its
// clients?") answered twice in a row on a preview, with no name leaked but no
// refusal either: the prompt's "answer the part you can" rule let it describe
// the clients without naming them. A prompt rule is a request; this is a
// check in code, so it holds every time and costs nothing.
//
// It is deliberately narrow. The documents use "client", "vendor" and
// "company" in ordinary ways ("client datasets", "company names" in output
// headers), so a keyword match would refuse real questions. Each rule pairs
// an identity noun with an identity ask. test/guardrail.test.mjs runs every
// answerable question in eval/questions.json through it and fails if any is
// blocked.

const PARTY =
  "(?:compan(?:y|ies)|firms?|organi[sz]ations?|business(?:es)?|employers?|vendors?|suppliers?|manufacturers?|oems?|clients?|customers?|owners?|developers?|makers?|builders?)";
const MADE =
  "(?:built|build|builds|made|make|makes|created|create|developed|develop|wrote|write|owns?|maintains?|sells?|funds?|paid for|commissioned|commission)";

const RULES = [
  // "Who built this tool?", "who developed the validator"
  // ("Who is this built for?" asks about users, which the PRD covers, so "for" is let through.)
  ["who_made", new RegExp(`\\bwho\\b[^?.]{0,40}\\b${MADE}\\b(?!\\s+for\\b)`, "i")],
  // "Who's behind this?", "whose tool is this"
  ["who_behind", new RegExp(`\\bwho(?:'s|\\s+is|\\s+are)?\\s+(?:really\\s+)?behind\\b|\\bwhose\\s+(?:tool|validator|product|project|spec|app|work)\\b`, "i")],
  // "Tell me who the client is"
  ["who_party_is", new RegExp(`\\bwho\\s+(?:the|its|their)\\s+(?:\\w+\\s+)?${PARTY}\\s+(?:is|are|was|were)\\b`, "i")],
  // "Which company built it?", "what clients use this", "which vendor is it"
  [
    "which_party",
    new RegExp(
      `\\b(?:which|what)\\s+(?:\\w+\\s+)?${PARTY}\\s+(?:is|are|was|were|uses?|used|${MADE}|behind|own|run|runs|receives?|gets?|is this|are these)\\b`,
      "i"
    ),
  ],
  // "Which company?" alone, or ending the question
  ["which_party_bare", new RegExp(`\\b(?:which|what)\\s+(?:\\w+\\s+)?${PARTY}\\s*[?.!]*\\s*$`, "i")],
  // "Who are its clients?", "who is the manufacturer"
  [
    "who_is_party",
    new RegExp(`\\bwho\\s+(?:is|are|was|were)\\s+(?:the\\s+|its\\s+|their\\s+|this\\s+tool'?s\\s+|the\\s+tool'?s\\s+)?(?:\\w+\\s+)?${PARTY}\\b`, "i"),
  ],
  // "Name the client", "list the vendors", "tell me the manufacturer"
  [
    "name_party",
    new RegExp(
      `\\b(?:name|list|identify|reveal|tell me|give me)\\b\\s+(?:the\\s+|its\\s+|their\\s+|any\\s+|all\\s+|every\\s+)?(?:\\w+\\s+)?${PARTY}\\b(?!\\s*(?:-side|side|export|exports|format|formats|dataset|datasets|data|schema|schemas|model|models|taxonomy|names?\\s+(?:as|in)))`,
      "i"
    ),
  ],
  // "What is the company's name", "the name of the client"
  // (Possessive only: "company names" in output headers is a real topic.)
  ["party_name", new RegExp(`\\b(?:name\\s+of\\s+(?:the\\s+|its\\s+|their\\s+)?${PARTY}|${PARTY}(?:'s|s')\\s+names?\\b)`, "i")],
];

export const IDENTITY_REFUSAL =
  "The published spec doesn't name the companies, clients or vendors involved, and this tool doesn't either. Try asking about a requirement, a test case, a field, a user story or a release.";

// Returns the name of the first rule that matched, or null.
export function identityQuestion(question) {
  const q = String(question || "");
  for (const [name, re] of RULES) if (re.test(q)) return name;
  return null;
}
