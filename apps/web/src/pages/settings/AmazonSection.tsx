// SPEC §6: Amazon is connected in the native apps only. The API has no import
// status yet, so there is no "last import" time to show (see the API gaps).
export function AmazonSection() {
  return (
    <section className="settings__section" aria-labelledby="settings-amazon">
      <h2 id="settings-amazon" className="settings__title">
        Amazon
      </h2>
      <p className="settings__text">
        Connect Amazon in the Porchlight app on your Mac or iPhone. The web can't sign in to Amazon for you.
      </p>
      <p className="settings__caption">
        Your Amazon sign-in stays on that device. Packages it finds show up here once they sync.
      </p>
    </section>
  );
}
