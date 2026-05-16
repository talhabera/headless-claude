// src/api.js
export function mountApi(app, { db, projects, poller, scheduler, executor }) {
  app.post("/projects", async (req, res) => {
    try {
      const p = await projects.register({
        repo: req.body.repo,
        watchLabel: req.body.watchLabel,
        baseBranch: req.body.baseBranch,
      });
      res.json(p);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/projects", (_req, res) => {
    res.json({ projects: projects ? projects.list() : [] });
  });

  app.delete("/projects/:slug", (req, res) => {
    projects.remove(req.params.slug);
    res.json({ ok: true });
  });

  app.get("/runs", (req, res) => {
    const { state, project } = req.query;
    let sql = "SELECT * FROM runs";
    const where = [];
    const args = [];
    if (state) (where.push("state=?"), args.push(state));
    if (project) (where.push("project_id=?"), args.push(Number(project)));
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY id DESC";
    res.json({ runs: db.prepare(sql).all(...args) });
  });

  app.get("/runs/:id", (req, res) => {
    const run = db.prepare("SELECT * FROM runs WHERE id=?").get(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    res.json({
      run,
      logs: db
        .prepare("SELECT * FROM run_logs WHERE run_id=? ORDER BY id")
        .all(run.id),
      artifacts: db
        .prepare("SELECT kind,content FROM run_artifacts WHERE run_id=?")
        .all(run.id),
    });
  });

  app.post("/runs/:id/retry", (req, res) => {
    const run = db.prepare("SELECT * FROM runs WHERE id=?").get(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    const next =
      (db
        .prepare(
          "SELECT MAX(attempt) a FROM runs WHERE project_id=? AND issue_number=?",
        )
        .get(run.project_id, run.issue_number).a || 0) + 1;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (project_id,issue_number,state,attempt,created_at,updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(run.project_id, run.issue_number, "queued", next, now, now);
    res.json({ ok: true, attempt: next });
  });

  app.post("/runs/:id/cancel", (req, res) => {
    const run = db.prepare("SELECT * FROM runs WHERE id=?").get(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    if (executor) {
      executor.cancel(Number(req.params.id));
    } else {
      db.prepare(
        "UPDATE runs SET state='failed', fail_reason='cancelled by user', updated_at=? WHERE id=?",
      ).run(new Date().toISOString(), run.id);
    }
    res.json({ ok: true });
  });

  app.post("/poll", async (_req, res) => {
    if (poller) await poller.tick();
    if (scheduler) await scheduler.tick();
    res.json({ ok: true });
  });
}
