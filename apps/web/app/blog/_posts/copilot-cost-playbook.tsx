/**
 * Blog post: what FreeCode did with GitHub's Copilot cost-efficiency write-up.
 * Every number here is recorded in docs/specs/2026-09-04-harness-cost-efficiency.md
 * and queue.md; change them there first.
 */

type Cell = string | { v: string; delta?: "good" | "bad" | "flat" };

function Table({ head, rows }: { head: string[]; rows: Cell[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) =>
                typeof c === "string" ? (
                  <td key={j}>{c}</td>
                ) : (
                  <td key={j} className={`delta ${c.delta ?? ""}`}>
                    {c.v}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const AB_HEAD = ["Metric", "Before", "After", "Δ"];

export default function CopilotCostPlaybook() {
  return (
    <>
      <h2>The number that started it</h2>
      <p>48.1 million input tokens. Seven user messages.</p>
      <p>
        That was one real session of{" "}
        <a href="https://github.com/ayandexyz/freecode">FreeCode</a>, my open-source CLI coding
        agent, replayed from its own logs in early August. Seven things I asked it to do, 229
        requests to the model, and a conversation that had grown to 270K tokens and was never
        compacted once. Roughly forty times the input tokens a comparable agent needed for the
        same work. One session was most of a day&rsquo;s quota.
      </p>
      <p>
        I spent August fixing the <em>history-shaped</em> half of that problem: prompt-cache
        stability, compaction, deduplicated re-reads, parallel tool calls. It worked. But it left
        the other half untouched: the <em>per-call payload</em>. Every tool result, every recurring
        instruction, costs tokens the moment it is sent &mdash; and then again on every later
        request for the rest of the session, because an agent re-sends its whole conversation on
        every model call.
      </p>
      <p>
        Then GitHub&rsquo;s Copilot team published{" "}
        <a href="https://github.blog/ai-and-ml/github-copilot/how-we-make-ai-coding-more-cost-efficient-without-sacrificing-task-quality/">
          &ldquo;How we make AI coding more cost-efficient without sacrificing task quality&rdquo;
        </a>
        , and it was exactly the half I had not done.
      </p>

      <h2>What GitHub actually said</h2>
      <p>
        The post describes four harness changes, each measured offline on agentic coding
        benchmarks and then validated in online A/B experiments on real traffic:
      </p>
      <Table
        head={["Technique", "Their measured saving"]}
        rows={[
          ["Selectively compress noisy install / build / test / lint output", "5.5%"],
          ["Remove line-number prefixes from file reads", "3.1% (about 5% offline)"],
          ["Compress the recurring tool prompt by about half", "2.9% (~1,300 tokens per turn)"],
          ["Deliver background completions inline, no polling turn", "2.3%"],
        ]}
      />
      <p>
        But the numbers were not the interesting part. The interesting part was the section
        called <strong>&ldquo;The local metric trap.&rdquo;</strong> Every aggressive per-call
        trim they tried first made the agent <em>cheaper per call and more expensive per task</em>.
        Cut a tool result too hard and the model does not shrug &mdash; it recovers. It re-runs the
        command. It re-reads the file. It takes an extra turn. And every extra turn re-sends the
        entire conversation. They named a tool that showed a &ldquo;local win&rdquo; while tokens
        and cost went up overall, and a tighter file-tool instruction that increased cost in
        production.
      </p>
      <p>
        Their governing principle, which I adopted word for word:{" "}
        <strong>optimize for the outcome, not the tool call.</strong>
      </p>
      <p>
        I decided to implement all four techniques in FreeCode. But with one rule I wrote at the
        top of the spec before touching any code: <strong>nothing flips a default by argument.</strong>{" "}
        Every change ships as an experiment behind a flag. A paired, interleaved A/B run on the
        eval suite measures the whole task end to end. The default only changes if cost drops
        while pass rate holds and <em>repeated tool calls</em> &mdash; the tell-tale of a recovery
        detour &mdash; do not rise.
      </p>
      <p>That rule is the whole story. Here is what happened when I followed it.</p>

      <h2>Step 0: Measure before you cut</h2>
      <p>
        The first thing I did was not build. It was audit. For each of GitHub&rsquo;s four
        techniques I wrote down where FreeCode actually stood, and I pulled a real recorded request
        out of the rollout log to see what a request carries:
      </p>
      <Table
        head={["Block", "Size on a real first turn"]}
        rows={[
          ["System prompt", "~2.2K tokens"],
          ["Tool definitions (16 tools)", "~4.7K tokens — led by grep, bash, memory, todowrite, agent"],
          ["Recurring block, every request", "~6.9K tokens"],
          ["Project context (file tree, instructions)", "the bulk of the rest"],
        ]}
      />
      <p>
        So before writing a line I knew that GitHub&rsquo;s &ldquo;halve the prompt&rdquo; would be
        worth roughly 3.4K tokens per request here &mdash; a number, not a hope.
      </p>
      <p>The audit also turned up something that was not in GitHub&rsquo;s list at all.</p>

      <h2>Step 1: The bug that made &ldquo;recovery&rdquo; a lie</h2>
      <p>
        FreeCode already had a recovery path for big tool outputs: the full text goes into a
        per-session output store, the model sees a capped head-and-tail view, and an{" "}
        <code>output</code> tool can page any of it back by line range or regex. Cheap recovery, no
        re-running.
      </p>
      <p>
        Except it did not work for the outputs that mattered. The bash tool was cutting its output
        at 500KB <em>before</em> the store ever saw it. So for any large output the store held
        already-truncated text, and the beginning of a huge log was simply gone. The only
        &ldquo;recovery&rdquo; was re-running the command &mdash; the exact detour GitHub had
        measured as a net loss.
      </p>
      <p>
        <strong>What I did:</strong> deleted bash&rsquo;s own cap entirely. Bash returns the full
        output; the orchestrator owns every cap, in a fixed order: store the full text first, then
        produce the 30K-character model view, then the UI copy. I added a regression test that
        pushes a 600KB output through the pipeline and checks every byte is retrievable through the
        store while both outbound copies are capped.
      </p>
      <p>
        No flag, no A/B &mdash; this was correctness, not an experiment. But it was a prerequisite
        for everything that followed: you cannot compress conservatively &ldquo;with a recovery
        path&rdquo; if the recovery path lies.
      </p>

      <h2>Step 2: Build the tripwire before the dangerous change</h2>
      <p>
        GitHub&rsquo;s scariest anecdote was about prompt compression. When they shortened their
        tool guidance, a compressed instruction quietly lost the nuance that told the model to run
        independent agents in parallel. Everything got slower and more expensive, and no token
        count could have caught it. Only behavioral testing did.
      </p>
      <p>
        FreeCode&rsquo;s system prompt carries the same load-bearing instruction: batch independent
        tool calls into one response. Three file reads in one message cost one round trip instead
        of three, and each avoided round trip is an entire conversation not re-sent. And that
        instruction was just prose. Any future edit could weaken it and nothing would go red.
      </p>
      <p>
        <strong>What I did:</strong> before compressing anything, I added a new expectation to
        FreeCode&rsquo;s eval harness &mdash; &ldquo;at least one model response in this run must
        emit N tool calls at once&rdquo; &mdash; and a trajectory case whose correct answer is two
        concurrency-safe reads in a single assistant message. Two details I cared about: it scores
        what the model <em>emitted</em>, not what ran, so a batch that gets permission-denied still
        counts as batching; and the loader rejects N below 2, because &ldquo;at least one tool
        call&rdquo; would assert nothing.
      </p>
      <p>
        Then I ran it against the current prompt to see it pass. A guard that has never been green
        guards nothing.
      </p>
      <p>I am glad I did this first. It earned its keep within hours (Step 7).</p>

      <h2>Step 3: Content-aware output compression &mdash; GitHub&rsquo;s biggest win</h2>
      <p>
        This was their 5.5%. The idea: a <code>git diff</code>, a <code>grep</code> result and an{" "}
        <code>npm install</code> log are completely different things, but a naive &ldquo;keep head
        and tail, drop the middle&rdquo; cap treats them identically &mdash; and the middle of a
        build log is exactly where the one line that says <code>ERROR:</code> is hiding.
      </p>
      <p>
        <strong>What I did:</strong> two pieces in two places, because each place knows something
        the other does not.
      </p>
      <ul>
        <li>
          <strong>Classify in the bash tool</strong>, because it is the only code that knows what
          command was run. Each result is tagged as <em>source</em> (cat, git diff, git show
          &mdash; never touched, the model asked for bytes), <em>search</em> (grep, rg, find
          &mdash; only consecutive duplicates collapse, a match line is never dropped),{" "}
          <em>log</em> (test, build, install output &mdash; keep head, tail and every
          failure-looking line, collapse the boring middle), or <em>unclassified</em> (untouched
          &mdash; conservative beats clever). A pipeline is classified by its last segment, so{" "}
          <code>npm test | grep FAIL</code> is search output, not a build log.
        </li>
        <li>
          <strong>Compress in the orchestrator</strong>, at the one place all tool output already
          gets capped, and crucially <em>after</em> the store put from Step 1 &mdash; so every
          collapsed region leaves a marker naming the retrieval handle. Nothing is ever more than
          one cheap call away.
        </li>
      </ul>
      <p>
        Unit and property tests pin the guarantees: the search compressor provably drops no
        distinct line; the log compressor keeps every failure pattern.
      </p>
      <p>
        And then I shipped it <strong>off by default</strong>, behind a flag. That felt strange for
        the technique with the biggest published number. It turned out to be the right call.
      </p>

      <h2>Step 4: The line-number experiment</h2>
      <p>
        FreeCode&rsquo;s <code>read</code> tool prefixed every line of every file with its number:{" "}
        <code>42: …</code>. Three to seven extra characters per line, on every file the model ever
        reads, re-sent on every later turn. GitHub removed theirs because nothing in their editing
        workflow consumed the numbers.
      </p>
      <p>
        On paper FreeCode was in the same position &mdash; its <code>edit</code> tool matches
        strings, not line numbers, and navigation numbers come from <code>grep -n</code> and LSP
        output. But &ldquo;on paper&rdquo; is an argument. Maybe the model quietly leaned on visible
        numbering to cite <code>file:line</code> in answers, or to disambiguate a repeated string
        before editing. Those are two different risks and they need two different suites to
        answer: a coding suite (does the end state still pass?) and a judged suite (is the answer
        still good, with an independent model grading it?).
      </p>
      <p>
        <strong>What I did:</strong> one deliberately boring change &mdash; the prefix is applied
        only when a flag says so. The one subtle detail: the flag is read <em>per call</em>, not at
        startup. The A/B runner flips environment between interleaved trials, and a startup-read
        variable would make both sides identical while the report confidently described an
        experiment that never ran. I allowlisted the key in the runner and wrote that rule down
        next to it.
      </p>

      <h2>Step 5: Fix the instrument</h2>
      <p>
        Here is the part I would have skipped a year ago. I ran the first output-compression A/B
        and it came back: 11 of 11 cases pass on both sides, quality unchanged. Great &mdash; and
        useless. The runner was reporting <em>only</em> pass rate. Tokens, cost, turns and repeated
        calls were all sitting in the per-trial results and being thrown away by the summary.
      </p>
      <p>
        For a harness experiment, those numbers <em>are</em> the result. Quality holding is the
        precondition; cost moving is the point.
      </p>
      <p>
        <strong>What I did:</strong> extended the A/B report so every side tallies tokens, USD
        (summed over priced trials only, so &ldquo;free&rdquo; and &ldquo;unknown price&rdquo; stay
        distinct), turns and repeated calls, and prints percentage deltas. Then I re-ran
        everything.
      </p>

      <h2>Step 6: The results</h2>
      <p>
        Every run below: same model on both sides (MiniMax-M3), both variants interleaved in one
        run so nothing else can confound the delta, three trials per case. The judged suite used a
        different model family as the grader, because the judge must never be the model under
        test.
      </p>

      <h3>Line numbers off &mdash; coding suite (11 cases)</h3>
      <Table
        head={["Metric", "Prefixes on", "Prefixes off", "Δ"]}
        rows={[
          ["Pass rate", "11/11, every trial", "11/11, every trial", { v: "unchanged", delta: "flat" }],
          ["Tokens", "1,317,158", "1,174,060", { v: "−10.9%", delta: "good" }],
          ["Cost", "$0.1566", "$0.1200", { v: "−23.4%", delta: "good" }],
          ["Turns", "152", "139", { v: "−13", delta: "good" }],
          ["Repeated calls", "5", "2", { v: "−3", delta: "good" }],
        ]}
      />

      <h3>Line numbers off &mdash; judged suite (6 cases, independent judge)</h3>
      <Table
        head={["Metric", "Prefixes on", "Prefixes off", "Δ"]}
        rows={[
          ["Pass rate", "6/6, every trial", "6/6, every trial", { v: "unchanged", delta: "flat" }],
          ["Tokens", "518,409", "482,906", { v: "−6.8%", delta: "good" }],
          ["Cost", "$0.0662", "$0.0536", { v: "−18.9%", delta: "good" }],
          ["Turns", "30", "29", { v: "−1", delta: "good" }],
          ["Repeated calls", "0", "0", { v: "unchanged", delta: "flat" }],
        ]}
      />
      <p>
        Both risks answered. Answer quality held without the numbers, edits still landed, and the
        cheaper side even repeated <em>fewer</em> calls &mdash; no hidden detour eating the saving.
        Notice that cost fell twice as fast as tokens: fewer turns means fewer whole-conversation
        re-sends, which is the quadratic term you actually pay for. The line numbers never earned
        their tokens. <strong>Default flipped to off the same day.</strong>
      </p>
      <p>
        Why is my number several times GitHub&rsquo;s 3.1%? Partly pricing, partly a small suite,
        but mostly because a small per-call saving compounds through the turn count. Their figure
        was normalized over an enormous, diverse production workload; mine is 11 tasks. I would not
        quote −23% as a universal truth. I would quote it as evidence that the prefix was pure cost
        for this agent.
      </p>

      <h3>Output compression on &mdash; coding suite (11 cases)</h3>
      <Table
        head={["Metric", "Compression off", "Compression on", "Δ"]}
        rows={[
          ["Pass rate", "11/11, every trial", "11/11, every trial", { v: "unchanged", delta: "flat" }],
          ["Tokens", "1,234,164", "1,381,547", { v: "+11.9%", delta: "bad" }],
          ["Cost", "$0.1363", "$0.1512", { v: "+10.9%", delta: "bad" }],
          ["Turns", "145", "160", { v: "+15", delta: "bad" }],
          ["Repeated calls", "3", "4", { v: "+1", delta: "bad" }],
        ]}
      />
      <p>
        GitHub&rsquo;s biggest win was my only loss. Correctness held &mdash; the classifier never
        broke anything &mdash; but the compressed side cost <em>more</em>. The trace shows why: the
        model saw an elision marker, decided it needed the middle, and spent extra turns paging it
        back through the output tool. Fifteen extra turns across the suite. That is the local
        metric trap, reproduced on my own codebase: every individual tool result got smaller, and
        the task got more expensive.
      </p>
      <p>
        I had shipped it flag-off &ldquo;because a default is earned, not asserted,&rdquo; half
        expecting to flip it. Instead the measurement said no. The classifier and the flag stay in
        the codebase for a retry with different thresholds or a model that recovers more cheaply.
        The default stays off. <strong>A saved experiment is knowing what not to ship.</strong>
      </p>

      <h2>Step 7: Compressing the prompt &mdash; and the day the tripwire fired</h2>
      <p>
        With the guard from Step 2 green, I compressed the recurring guidance by hand, section by
        section: the system prompt, and the five fattest tool descriptions. I kept the
        parallel-batching instruction deliberately strong. Then I ran the release gate.
      </p>
      <p>
        The first compressed version failed. A case called <em>explore-mode-stays-readonly</em>{" "}
        went red twice in a row. Reading the trial data, the model was burning an extra turn by
        calling the <code>question</code> tool in a mode where it gets rejected. I stashed the
        compression, re-ran on the original prompt as a control: it passed. The compression was
        convicted.
      </p>
      <p>
        The culprit was one sentence I had cut as filler:{" "}
        <em>&ldquo;requesting input from the user is a blocking action.&rdquo;</em> Without it, the
        model reached for a question instead of reporting a blocked action plainly. Version two
        restored that rule, added an explicit &ldquo;if an action is blocked, report it instead of
        asking,&rdquo; and matched the original prompt&rsquo;s score.
      </p>
      <p>
        Read that again next to GitHub&rsquo;s story. Their compression silently changed a
        parallelism behavior; mine silently changed an asking behavior. Neither is visible in a
        token count. Both were caught only by a behavioral test. The guard I built &ldquo;just in
        case&rdquo; in Step 2 caught a regression in Step 7 of the same day.
      </p>
      <Table
        head={AB_HEAD}
        rows={[
          ["System prompt", "8,862 chars (~2.2K tokens)", "5,446 chars", { v: "−38.5%", delta: "good" }],
          ["Five largest tool descriptions", "~9.8K chars", "roughly halved", { v: "~−50%", delta: "good" }],
          ["Trajectory gate", "—", "GATE OPEN — batching guard green across 3 trials", ""],
          ["Coding gate", "—", "GATE OPEN — 11/11", ""],
          ["Judged gate", "—", "GATE OPEN — mean 4.83 / 5, no case below 4", ""],
        ]}
      />
      <p>
        Put together, the recurring block that rides every request went from roughly 27.7K
        characters to roughly 19.4K &mdash; about 30% smaller, on the order of two thousand tokens
        saved on every single model call before the conversation has even started growing. (That
        last figure is derived from the recorded character counts, not a separate cost A/B; the
        gate measured quality, not dollars.) The judge&rsquo;s own rationales were the nicest
        confirmation that the style survived: &ldquo;direct, no unnecessary padding,&rdquo;
        &ldquo;omitting preamble as requested&rdquo; &mdash; exactly the qualities a clumsy trim
        destroys.
      </p>

      <h2>Step 8: The technique that cost nothing</h2>
      <p>
        GitHub&rsquo;s fourth technique &mdash; deliver finished background work inside a model
        call that was going to happen anyway, never in a dedicated &ldquo;is it done yet?&rdquo;
        turn &mdash; did not apply to FreeCode at the time. When the model issues several
        independent tool calls in one response, the batching layer runs them concurrently and
        returns every result in the same follow-up call. There was no polling turn to eliminate
        because nothing ran detached from the loop.
      </p>
      <p>
        So I did not write code. I wrote a rule into the spec:{" "}
        <em>
          a background completion is delivered as an ordinary tool result in the next
          already-happening model call, never via a retrieval turn. Four calls to process two
          results is the named anti-pattern.
        </em>
      </p>
      <p>
        Four days later FreeCode grew background shells &mdash; a long build or a dev server no
        longer holds the turn. And the rule immediately mattered, because that feature is pull-only
        today: the model learns a shell finished only by asking. The push notification that makes
        the result arrive on its own is designed and next on the list. The cheapest of the four
        techniques was adopting the constraint before the feature that could violate it existed.
      </p>

      <h2>What I actually learned</h2>
      <p>
        <strong>1. The measurement is the deliverable.</strong> The most valuable commit of the
        day was not a compression &mdash; it was making the A/B runner print cost. Without it I
        would have shipped output compression on a green pass rate and made my agent 11% more
        expensive while believing I had made it cheaper.
      </p>
      <p>
        <strong>2. Ship every trim behind a flag, off.</strong> GitHub&rsquo;s largest published
        saving was a loss on my workload. Their numbers are true for their traffic.
        &ldquo;Evidence is local to the workload&rdquo; is not a disclaimer; it is the reason to
        run your own experiment.
      </p>
      <p>
        <strong>3. Build the guard before the change.</strong> Prompt edits fail silently and
        behaviorally. A token count cannot see a model that starts asking questions it should not
        ask. A one-line eval case can.
      </p>
      <p>
        <strong>4. Watch repeated calls, not just tokens.</strong> A rising repeat count is the
        fingerprint of the recovery detour. It flagged the compression loss and confirmed the
        line-number win.
      </p>
      <p>
        <strong>5. A negative result is still a result.</strong> The compression code stays. The
        flag stays. The verdict is written down with the numbers. The next person &mdash; probably
        me &mdash; will not re-argue it from first principles.
      </p>
      <p>
        Four techniques from a GitHub post. One flipped a default and cut task cost by a fifth. One
        halved a prompt under a gate that caught the regression it caused. One was recorded as a
        rule and became relevant four days later. And one &mdash; the biggest on paper &mdash; was
        measured, rejected, and kept on the shelf. That last outcome is the one I am proudest of,
        because it is the one the post was actually about.
      </p>

      <hr />
      <p>
        <em>
          FreeCode is open source. The full spec, the A/B commands, and every number above live in
          the repo under <code>docs/specs/2026-09-04-harness-cost-efficiency.md</code> and the
          &ldquo;Cost efficiency&rdquo; section of the docs site.
        </em>
      </p>
    </>
  );
}
