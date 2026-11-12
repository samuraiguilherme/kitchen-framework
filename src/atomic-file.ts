import { renameSync } from "node:fs";

const renameWait = new Int32Array(new SharedArrayBuffer(4));

export function replaceFileSync(temporary: string, destination: string): void {
  for (const delayMs of [20, 40, 80, 160, 320]) {
    try {
      renameSync(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      // An open handle can temporarily prevent replacement. Keep the previous
      // destination available and retry the same atomic rename.
      Atomics.wait(renameWait, 0, 0, delayMs);
    }
  }
  renameSync(temporary, destination);
}
