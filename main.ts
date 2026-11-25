// Pump.fun Sharpe Sprint — cleanest paper bot wins.
//
// One strategy program, main.ts on Node 22, stdlib only. It trades paper
// money on a 6-hour pump.fun forward replay: the grader speaks
// agent-fun/replay/v2 on stdin/stdout (hello / batch / done), and this file
// only wires that wire protocol (vendor/makefun-bot.ts) to the strategy in
// strategy.ts. Nothing here touches the network, the clock, the environment
// or unseeded randomness, so two runs on the same replay behave identically.
//
// Strategy in one line: buy young coins only after they show real buying
// pressure, stake a fixed small slice, bank +15%, cut -7%, trail winners,
// and free the slot when a coin goes quiet. See strategy.ts for the rules.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();
let batches = 0;

const { state, done } = await runBot({
  onBatch(botState, batch) {
    batches += 1;
    return strategy.onBatch(botState, batch);
  },
  onDone(botState, finished) {
    // Diagnostics go to stderr; stdout carries replies only.
    const start = BigInt(botState.hello.capital.lamports);
    const end = BigInt(finished.account.cash_lamports);
    console.error(
      `done: ${finished.reason} after ${batches} batches; ` +
        `cash ${start} -> ${end} lamports (${end >= start ? '+' : ''}${end - start}); ` +
        `open positions ${finished.account.positions.length}`,
    );
  },
});

void state;
void done;
