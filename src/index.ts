import { parseFlags } from "./flags.ts";
import { runNonInteractive } from "./non-interactive.ts";

const flags = parseFlags(process.argv.slice(2));

if (flags.nonInteractive) {
  await runNonInteractive(flags);
} else {
  const { runTui } = await import("./ui.ts");
  await runTui(flags);
}
