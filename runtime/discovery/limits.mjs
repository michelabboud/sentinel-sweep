// 16 MiB matches Sentinel's persisted artifact/history ceiling while leaving room for
// practical API contracts and router sources without letting target data dominate memory.
export const MAX_DISCOVERY_INPUT_BYTES = 16 * 1024 * 1024;

// 64 literal containers cover realistic declarative route metadata with ample margin while
// keeping mutually recursive parser calls far below V8's environment-dependent stack limit.
// This bounds TOTAL nesting from the parse root — the stack is what it protects — so the
// enclosing routes array, route object, and `meta` each spend one of the 64.
export const MAX_VUE_LITERAL_DEPTH = 64;
