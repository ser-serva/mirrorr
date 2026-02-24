import { PlopTypes } from "@turbo/gen";

function validatePackageName(input: string): true | string {
  if (!input) return "name is required";
  if (input.includes(" ")) return "name cannot include spaces";
  if (input.includes(".")) return "name cannot include dots";
  return true;
}

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  // ── Adapter package generator ─────────────────────────────────────────────
  plop.setGenerator("adapter", {
    description: "Create a new adapter package under packages/adapter-{name}",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Adapter name (e.g. youtube-shorts, bluesky):",
        validate: validatePackageName,
      },
      {
        type: "list",
        name: "kind",
        message: "Adapter kind:",
        choices: ["source", "target"],
      },
    ],
    actions: (data) => [
      {
        type: "add",
        path: "{{ turbo.paths.root }}/packages/adapter-{{ dashCase name }}/package.json",
        templateFile: "templates/adapter/package.json.hbs",
        skipIfExists: true,
      },
      {
        type: "add",
        path: "{{ turbo.paths.root }}/packages/adapter-{{ dashCase name }}/tsconfig.json",
        templateFile: "templates/adapter/tsconfig.json.hbs",
        skipIfExists: true,
      },
      {
        type: "add",
        path: "{{ turbo.paths.root }}/packages/adapter-{{ dashCase name }}/src/index.ts",
        templateFile: `templates/adapter/src/index.${data?.kind ?? "source"}.ts.hbs`,
        skipIfExists: true,
      },
    ],
  });

  // ── App generator ─────────────────────────────────────────────────────────
  plop.setGenerator("app", {
    description: "Create a new app under apps/{name}",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "App name (e.g. backend, frontend, worker):",
        validate: validatePackageName,
      },
    ],
    actions: [
      {
        type: "add",
        path: "{{ turbo.paths.root }}/apps/{{ dashCase name }}/package.json",
        templateFile: "templates/app/package.json.hbs",
        skipIfExists: true,
      },
      {
        type: "add",
        path: "{{ turbo.paths.root }}/apps/{{ dashCase name }}/tsconfig.json",
        templateFile: "templates/app/tsconfig.json.hbs",
        skipIfExists: true,
      },
      {
        type: "add",
        path: "{{ turbo.paths.root }}/apps/{{ dashCase name }}/src/index.ts",
        templateFile: "templates/app/src/index.ts.hbs",
        skipIfExists: true,
      },
    ],
  });
}
