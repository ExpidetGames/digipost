import "server-only";

/**
 * Privileged entrypoint of `src/platform/mistral`. Never imported from client-reachable
 * code. `getOcrEngine`/`getDocumentAnalyzer` are what `create-request-services.ts` binds;
 * `isFakeAiProviderActive` backs the UI's "Testmodus: KI-Simulation aktiv" hint.
 */
export { getDocumentAnalyzer, getOcrEngine, isFakeAiProviderActive, resetAiAdaptersForTests } from "./server/get-ai-adapters";
// F1a (decisions/0020-universal-intake.md): the universal intake recognizer's own adapter
// getter, kept in a separate file from the one above (see `get-intake-classifier.ts`'s own
// header comment for why), re-exported from this same privileged entrypoint.
export { getIntakeClassifier, resetIntakeClassifierForTests } from "./server/get-intake-classifier";
// F3a (decisions/0023-payment-matching.md): the payment arbiter's own adapter getter, kept in
// a separate file from the two above for the same reason (see `get-payment-arbiter.ts`'s own
// header comment), re-exported from this same privileged entrypoint.
export { getPaymentArbiter, resetPaymentArbiterForTests } from "./server/get-payment-arbiter";
