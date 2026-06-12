/**
 * Echo-suppression state shared by the two directions of one binding.
 * Automerge changes cannot carry arbitrary origin markers (unlike Yjs
 * transactions), so each binding owns a flag pair instead: every listener
 * ignores events raised while the opposite direction is applying.
 */
export interface SyncOrigin {
  /** true while the outbound binding is writing into the doc */
  local: boolean;
  /** true while the inbound binding is applying onto the tree */
  remote: boolean;
}

export const newOrigin = (): SyncOrigin => ({ local: false, remote: false });
