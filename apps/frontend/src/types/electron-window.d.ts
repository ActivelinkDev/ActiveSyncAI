// apps/frontend/src/types/electron-window.d.ts
declare global {
  interface Window {
    electronAPI?: {
      minimize(): Promise<void>;
      toggleMaximize(): Promise<boolean>;
      close(): Promise<void>;
      onMaxChange?(cb: (isMax: boolean) => void): void;
    };
    electronWindow?: Window['electronAPI']; // alias
  }
}
export {};
