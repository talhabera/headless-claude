// src/projects.js
import { join } from "node:path";

export function slugify(repo) {
  return repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function createProjects({ db, git, projectsDir }) {
  return {
    async register({ repo, watchLabel, baseBranch }) {
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
        `INSERT INTO projects (slug,repo,local_path,watch_label,base_branch,created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        slug,
        repo,
        localPath,
        watchLabel,
        baseBranch,
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
      db.prepare("DELETE FROM projects WHERE slug=?").run(slug);
    },
  };
}
