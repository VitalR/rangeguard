#!/usr/bin/env node
import { Command } from "commander";
import { statusCommand } from "./commands/status";
import { bootstrapCommand } from "./commands/bootstrap";
import { collectCommand } from "./commands/collect";
import { rebalanceCommand } from "./commands/rebalance";
import { doctorCommand } from "./commands/doctor";
import { logger } from "./logger";
import { formatError } from "./utils/errors";

const program = new Command();

program
  .name("keepers")
  .description("RangeGuard keeper CLI")
  .version("0.1.0");

program
  .command("status")
  .description("Show vault position status")
  .action(async () => {
    await statusCommand();
  });

program
  .command("doctor")
  .description("Verify config and vault state")
  .action(async () => {
    await doctorCommand();
  });

program
  .command("bootstrap")
  .description("Bootstrap initial position")
  .option("--send", "Send transaction (default is dry run)")
  .option("--amount0 <amount0>", "Amount of token0 to use if useFullBalances=false")
  .option("--amount1 <amount1>", "Amount of token1 to use if useFullBalances=false")
  .action(async (options) => {
    await bootstrapCommand(options);
  });

program
  .command("collect")
  .description("Collect fees from current position")
  .option("--send", "Send transaction (default is dry run)")
  .action(async (options) => {
    await collectCommand(options);
  });

program
  .command("rebalance")
  .description("Rebalance the position if policy allows")
  .option("--send", "Send transaction (default is dry run)")
  .option("--amount0 <amount0>", "Amount of token0 to use if useFullBalances=false")
  .option("--amount1 <amount1>", "Amount of token1 to use if useFullBalances=false")
  .action(async (options) => {
    await rebalanceCommand(options);
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error("CLI failed", { error: formatError(err) });
  process.exitCode = 1;
});
