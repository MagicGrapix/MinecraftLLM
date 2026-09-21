export type ChatIntent =
  | { readonly kind: "readonly_question"; readonly confidence: number }
  | { readonly kind: "action_request"; readonly confidence: number }
  | { readonly kind: "conversation"; readonly confidence: number }
  | { readonly kind: "unclear"; readonly confidence: number };
