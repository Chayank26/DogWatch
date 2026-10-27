export default function Home() {
  return (
    <main>
      <p className="eyebrow">DogWatch · Pull request QA</p>
      <h1>A second pair of eyes for every pull request.</h1>
      <p className="intro">
        Autonomous QA that will inspect changed code, test APIs, and explore
        your application before merge.
      </p>
      <section aria-labelledby="status">
        <h2 id="status">Start with your workspace</h2>
        <p>
          Sign in with GitHub, create your first workspace, and review your
          setup progress before connecting repositories.
        </p>
        <ol>
          <li>Connect a GitHub repository.</li>
          <li>Configure a preview and test accounts.</li>
          <li>Request QA on a pull request.</li>
          <li>Review findings and evidence.</li>
        </ol>
        <a className="button" href="/onboarding">
          Set up your workspace
        </a>
      </section>
    </main>
  );
}
