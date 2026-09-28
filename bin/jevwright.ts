#!/usr/bin/env node
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // User setup code can leave handles open (a database pool, a dev server); the run is over either way.
    setTimeout(() => process.exit(code), 2000).unref();
}).catch((error: unknown) => {
    process.stderr.write(`jevwright: internal error; please report it at https://github.com/Ice-Hazymoon/jevwright/issues\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 3;
    setTimeout(() => process.exit(3), 2000).unref();
});
