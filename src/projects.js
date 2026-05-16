// src/projects.js
import { join } from "node:path";
import { rmSync } from "node:fs";

export function slugify(repo) {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function createProjects({ db, git, projectsDir }) {
  return {
    async register({ repo, watchLabel, baseBranch, previewBranch, previewUrl }) {
      const slug = slugify(repo);
      const existing = db
        .prepare("SELECT 1 FROM projects WHERE slug=?")
        .get(slug);
      if (existing) throw new Error(`project ${repo} already registered`);
      const localPath = join(projectsDir, slug);
      const r = git(projectsDir, [
        "clone",
        `https://github.com/${repo}`,
        slug,
      ]);
      if (r.code !== 0) throw new Error(`clone failed: ${r.stderr.trim()}`);
      db.prepare(
        `INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,preview_branch,preview_url,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        slug,
        repo,
        localPath,
        watchLabel,
        baseBranch,
        previewBranch ?? null,
        previewUrl ?? null,
        new Date().toISOString(),
      );
      return db.prepare("SELECT * FROM projects WHERE slug=?").get(slug);
    },
    list() {
      return db.prepare("SELECT * FROM projects ORDER BY id").all();
    },
    get(slug) {
      return db.prepare("SELECT * FROM projects WHERE slug=?").get(slug);
    },
    remove(slug) {
      const project = db.prepare("SELECT * FROM projects WHERE slug=?").get(slug);
      if (!project) return;
      // Delete child rows in dependency order
      const runIds = db
        .prepare("SELECT id FROM runs WHERE project_id=?")
        .all(project.id)
        .map((r) => r.id);
      if (runIds.length > 0) {
        const placeholders = runIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM run_logs WHERE run_id IN (${placeholders})`).run(...runIds);
        db.prepare(`DELETE FROM run_artifacts WHERE run_id IN (${placeholders})`).run(...runIds);
      }
      db.prepare("DELETE FROM runs WHERE project_id=?").run(project.id);
      db.prepare("DELETE FROM issue_deps WHERE project_id=?").run(project.id);
      // Remove clone directory (idempotent — force:true silently skips missing dirs)
      try {
        rmSync(project.local_path, { recursive: true, force: true });
      } catch {
        // ignore errors from missing or unreadable directory
      }
      db.prepare("DELETE FROM projects WHERE slug=?").run(slug);
    },
  };
}
