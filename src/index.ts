import { parseFlags } from "./flags.ts";
import { runDiagnose } from "./diagnose.ts";
import { configFromFlags } from "./non-interactive.ts";
import { runNonInteractive } from "./non-interactive.ts";

const flags = parseFlags(process.argv.slice(2));

if (flags.diagnose) {
  const config = await configFromFlags(flags);
  process.exit(await runDiagnose(config));
} else if (flags.nonInteractive) {
  await runNonInteractive(flags);
} else {
  const { runTui } = await import("./ui.ts");
  await runTui(flags);
}
