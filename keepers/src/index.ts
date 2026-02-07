#!/usr/bin/env node
import { Command } from "commander";
import { statusCommand } from "./commands/status";
import { bootstrapCommand } from "./commands/bootstrap";
import { collectCommand } from "./commands/collect";
import { rebalanceCommand } from "./commands/rebalance";
import { closePositionCommand } from "./commands/closePosition";
import { doctorCommand } from "./commands/doctor";
import { quoteCommand } from "./commands/quote";
import { swapCommand } from "./commands/swap";
import { initPoolCommand } from "./commands/initPool";
import { probePoolsCommand } from "./commands/probePools";
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
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .option("--positionId <id>", "Position id to inspect")
  .action(async (options) => {
    await statusCommand(options);
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
  .option("--bufferBps <bps>", "Bps buffer applied to derived quote (default 200)")
  .option("--maxSpendBps <bps>", "Max spend bps of vault balances (default 10000)")
  .option("--widthTicks <ticks>", "Override policy width ticks for this run")
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .action(async (options) => {
    await bootstrapCommand(options);
  });

program
  .command("collect")
  .description("Collect fees from current position")
  .option("--send", "Send transaction (default is dry run)")
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .option("--positionId <id>", "Position id to collect from")
  .action(async (options) => {
    await collectCommand(options);
  });

program
  .command("closePosition")
  .description("Close current position and collect all fees")
  .option("--send", "Send transaction (default is dry run)")
  .option("--force", "Ignore cooldown (demo only)")
  .option("--amount0Min <amount0Min>", "Minimum token0 output for burn (default 0)")
  .option("--amount1Min <amount1Min>", "Minimum token1 output for burn (default 0)")
  .option("--hookDataHex <hex>", "Hook data hex (default 0x)")
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .option("--positionId <id>", "Position id to close")
  .action(async (options) => {
    await closePositionCommand(options);
  });

program
  .command("rebalance")
  .description("Rebalance the position if policy allows")
  .option("--send", "Send transaction (default is dry run)")
  .option("--amount0 <amount0>", "Amount of token0 to use if useFullBalances=false")
  .option("--amount1 <amount1>", "Amount of token1 to use if useFullBalances=false")
  .option("--bufferBps <bps>", "Bps buffer applied to derived quote (default 200)")
  .option("--maxSpendBps <bps>", "Max spend bps of vault balances (default 10000)")
  .option("--force", "Force rebalance even if triggers are not met")
  .option("--dryPlan", "Print plan only (no simulation)")
  .option("--widthTicks <ticks>", "Override policy width ticks for this run")
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .option("--positionId <id>", "Position id to rebalance")
  .action(async (options) => {
    await rebalanceCommand(options);
  });

program
  .command("quote")
  .description("Quote token0/token1 amounts using Quoter")
  .option("--amount0 <amount0>", "Amount of token0 to quote into token1")
  .option("--amount1 <amount1>", "Amount of token1 to quote into token0")
  .option("--bufferBps <bps>", "Bps buffer applied to the quoted output (default 0)")
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .action(async (options) => {
    await quoteCommand(options);
  });

program
  .command("swap")
  .description("Swap token0/token1 via swap router")
  .option("--send", "Send transaction (default is dry run)")
  .option("--amount0 <amount0>", "Exact token0 input to swap into token1")
  .option("--amount1 <amount1>", "Exact token1 input to swap into token0")
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .action(async (options) => {
    await swapCommand(options);
  });

program
  .command("initPool")
  .description("Initialize a Uniswap v4 pool")
  .option("--priceUsdcPerWeth <price>", "USDC per WETH price (default 2000)")
  .option("--sqrtPriceX96 <value>", "Override sqrtPriceX96 (hex or decimal)")
  .option("--hookDataHex <hex>", "Hook data hex (default 0x)")
  .option("--send", "Send transaction (default is dry run)")
  .option("--json", "Output report JSON only")
  .option("--out <path>", "Write report to a custom path")
  .option("--verbose", "Include verbose report fields")
  .action(async (options) => {
    await initPoolCommand(options);
  });

program
  .command("probePools")
  .description("Probe common pool keys and report ticks")
  .option("--json", "Output JSON only")
  .option("--limit <n>", "Stop after N initialized pools that pass sanity gate")
  .option("--preferFee <fee>", "Sort results by closeness to preferred fee")
  .action(async (options) => {
    await probePoolsCommand(options);
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error("CLI failed", { error: formatError(err) });
  process.exitCode = 1;
});
