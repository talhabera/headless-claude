// src/prReview.js
import { existsSync } from "node:fs";
import { recordSuccess, recordFailure } from "./runCooldown.js";

const CAP_MARKER = "pr-review: iteration cap reached";

export function createPrReview({ db, gh, workspace, stages, claude, config, runLock, now = () => Date.now() }) {
  let botLoginCache;

  async function resolveBotLogin() {
    if (config.botLogin) return config.botLogin;
    if (botLoginCache !== undefined) return botLoginCache;
    try {
      botLoginCache = await gh.viewer();
      return botLoginCache;
    } catch {
      return ""; // do NOT cache failure — retry next tick
    }
  }

  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const projects = db.prepare("SELECT * FROM projects").all();
      const nowIso = new Date(now()).toISOString();
      for (const p of projects) {
        const runs = db
          .prepare(
            `SELECT * FROM runs
               WHERE project_id=? AND state='pr_open'
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
          )
          .all(p.id, nowIso);
        for (const r of runs) {
          await runLock.runExclusive(r.id, async () => {
            try {
              const didWork = await handleRun(p, r);
              if (didWork) recordSuccess(db, r.id, config, now());
            } catch (e) {
              recordFailure(db, r.id, config, now());
              // eslint-disable-next-line no-console
              console.error(`prReview run ${r.id}: ${e.message}`);
            }
          });
        }
      }
    } finally {
      running = false;
    }
  }

  async function handleRun(p, r) {
    if (!r.worktree_path) return;

    if (!existsSync(r.worktree_path)) {
      db.prepare(
        "UPDATE runs SET needs_attention=1, attention_reason=?, updated_at=? WHERE id=?",
      ).run(
        "pr-review: worktree missing on disk",
        new Date().toISOString(),
        r.id,
      );
      return;
    }

    const isReviewCapAttention =
      r.needs_attention === 1 &&
      typeof r.attention_reason === "string" &&
      r.attention_reason.startsWith(CAP_MARKER);
    if (r.needs_attention === 1 && !isReviewCapAttention) return;

    let status;
    try {
      status = await gh.prStatus(p.repo, r.branch);
    } catch {
      return;
    }
    if (!status || status.state !== "OPEN") return;
    const prNumber = status.number;

    const botLogin = await resolveBotLogin();
    const comments = (await gh.prComments(p.repo, r.branch)) || [];

    // Cold-start baseline: on first encounter (no watermark yet) with existing
    // comments, record the newest comment's timestamp and skip acting this
    // tick — otherwise every historical (already-addressed) comment would
    // satisfy `createdAt > ""` and replay through Path A. The NEXT tick then
    // proceeds to Path B review normally (pr_phase='reviewing',
    // pr_reviewed_diff_id still NULL).
    if (!r.pr_last_comment_at && comments.length > 0) {
      const newest = comments
        .map((c) => c && c.createdAt)
        .filter(Boolean)
        .sort()
        .pop();
      db.prepare(
        "UPDATE runs SET pr_last_comment_at=?, pr_phase=COALESCE(pr_phase,'reviewing'), updated_at=? WHERE id=?",
      ).run(newest, new Date().toISOString(), r.id);
      return;
    }

    const watermark = r.pr_last_comment_at || "";
    const newUserComments = comments
      .filter(
        (c) =>
          c &&
          c.author &&
          c.author.login !== botLogin &&
          (c.createdAt || "") > watermark,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    // NOTE: no outer mutex wrapper here. workspace.diffFingerprint and
    // workspace.pushBranch each already serialize on project.slug via the
    // (non-reentrant) keyed mutex. Wrapping this body in
    // workspace.runExclusive(p, ...) would re-enter the same key and
    // self-deadlock. The synchronous better-sqlite3 writes need no lock.
    // This mirrors prSweep, which also calls the self-locking workspace
    // methods directly without an outer wrapper.
    if (newUserComments.length > 0) {
      const newest = newUserComments[newUserComments.length - 1].createdAt;
      const changeRequest = newUserComments
        .map((c) => `- ${c.body}`)
        .join("\n");
      const fix = await stages.runPrFix({
        claude,
        cwd: r.worktree_path,
        changeRequest: `User review comments to address:\n${changeRequest}`,
        timeoutMs: config.stageTimeoutMs,
      });
      await workspace.pushBranch(p, r.worktree_path, r.branch);
      db.prepare(
        `UPDATE runs SET pr_last_comment_at=?, pr_review_iterations=0,
           pr_reviewed_diff_id=NULL, pr_phase='reviewing',
           needs_attention=CASE WHEN ? THEN 0 ELSE needs_attention END,
           attention_reason=CASE WHEN ? THEN NULL ELSE attention_reason END,
           updated_at=?
         WHERE id=?`,
      ).run(
        newest,
        isReviewCapAttention ? 1 : 0,
        isReviewCapAttention ? 1 : 0,
        new Date().toISOString(),
        r.id,
      );
      // Reply LAST, best-effort: a failed post must not re-trigger Path A
      // (watermark already advanced above).
      try {
        await gh.prComment(
          p.repo,
          prNumber,
          fix.ok
            ? `Addressed your comment(s): ${fix.summary}`
            : `Attempted your comment(s) but the change gate did not pass: ${fix.summary}`,
        );
      } catch {}
      return true;
    }

    const fingerprint = await workspace.diffFingerprint(p, r.worktree_path);
    if ((r.pr_phase || "reviewing") === "waiting_user" &&
        r.pr_reviewed_diff_id === fingerprint) {
      return;
    }
    // Defensive no-op safety-net: skip re-review when the diff is unchanged
    // and the phase is anything other than "reviewing"/"waiting_user"
    // (the explicit waiting_user case is handled by the guard above; this
    // covers any future non-reviewing/waiting_user phase value).
    if (r.pr_reviewed_diff_id === fingerprint &&
        (r.pr_phase || "reviewing") !== "reviewing") {
      return;
    }

    const review = await stages.runPrReview({
      db,
      run: r,
      claude,
      cwd: r.worktree_path,
      base: p.base_branch || "main",
      timeoutMs: config.stageTimeoutMs,
    });

    if (review.verdict === "approve") {
      db.prepare(
        `UPDATE runs SET pr_phase='waiting_user', pr_reviewed_diff_id=?,
           updated_at=? WHERE id=?`,
      ).run(fingerprint, new Date().toISOString(), r.id);
      await gh.prComment(
        p.repo,
        prNumber,
        "✅ automated review passed — waiting for your comments.",
      );
      return true;
    }

    const iterations = r.pr_review_iterations || 0;
    if (iterations >= config.prReviewMaxIterations) {
      const findings = (review.findings || []).map((f) => `- ${f}`).join("\n");
      db.prepare(
        `UPDATE runs SET pr_phase='waiting_user', needs_attention=1,
           attention_reason=?, pr_reviewed_diff_id=?,
           updated_at=? WHERE id=?`,
      ).run(
        `${CAP_MARKER} (${config.prReviewMaxIterations})`,
        fingerprint,
        new Date().toISOString(),
        r.id,
      );
      await gh.prComment(
        p.repo,
        prNumber,
        `Automated review hit the ${config.prReviewMaxIterations}-iteration cap. Remaining findings — waiting for your guidance:\n${findings}`,
      );
      return true;
    }

    const fix = await stages.runPrFix({
      claude,
      cwd: r.worktree_path,
      changeRequest:
        `Address these code-review findings:\n` +
        (review.findings || []).map((f) => `- ${f}`).join("\n") +
        (review.notes ? `\n\nReviewer notes: ${review.notes}` : ""),
      timeoutMs: config.stageTimeoutMs,
    });
    await workspace.pushBranch(p, r.worktree_path, r.branch);
    db.prepare(
      `UPDATE runs SET pr_review_iterations=?, pr_phase='reviewing',
         pr_reviewed_diff_id=NULL, updated_at=? WHERE id=?`,
    ).run(iterations + 1, new Date().toISOString(), r.id);
    // Path D stays quiet on success; surface only a non-passing gate,
    // best-effort (after the DB write so a failed post can't re-trigger).
    if (!fix.ok) {
      try {
        await gh.prComment(
          p.repo,
          prNumber,
          `Automated fix attempt did not pass the change gate: ${fix.summary}`,
        );
      } catch {}
    }
    return true;
  }

  return { tick };
}
