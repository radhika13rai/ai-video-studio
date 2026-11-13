import { Layout } from "../components/Layout";
import { Link, matchRoute, usePath } from "../lib/router";
import { NewProjectPage } from "../pages/NewProjectPage";
import { ProjectPage } from "../pages/ProjectPage";
import { ProjectsPage } from "../pages/ProjectsPage";
import { StatusPage } from "../pages/StatusPage";
import "./app.css";

export function App() {
  const route = matchRoute(usePath());
  return (
    <Layout route={route}>
      {route.name === "projects" && <ProjectsPage />}
      {route.name === "new" && <NewProjectPage />}
      {route.name === "project" && <ProjectPage key={route.id} id={route.id} />}
      {route.name === "status" && <StatusPage />}
      {route.name === "not-found" && (
        <section className="narrow">
          <h1>Page not found</h1>
          <Link href="/" className="btn">
            Go to your projects
          </Link>
        </section>
      )}
    </Layout>
  );
}
