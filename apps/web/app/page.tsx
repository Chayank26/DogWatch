export default function Home() {
  return (
    <main>
      <p className="eyebrow">DogWatch · Project foundation</p>
      <h1>A second pair of eyes for every pull request.</h1>
      <p className="intro">
        Autonomous QA that will inspect changed code, test APIs, and explore
        your application before merge.
      </p>
      <section aria-labelledby="status">
        <h2 id="status">We’re building the foundation</h2>
        <p>
          This is the initial project shell. Repository connections and QA runs
          will become available in later phases.
        </p>
        <ol>
          <li>Connect a GitHub repository.</li>
          <li>Configure a preview and test accounts.</li>
          <li>Request QA on a pull request.</li>
          <li>Review findings and evidence.</li>
        </ol>
        <p className="note">No sign-in or data collection is enabled yet.</p>
      </section>
    </main>
  );
}
