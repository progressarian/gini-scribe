import { deltaText } from "./progressText.js";

export default function DoctorsAdded({ added }) {
  const delta = deltaText(added.added, added.previous);
  return (
    <section className="prg__section" aria-labelledby="prg-added">
      <h2 id="prg-added" className="prg__h2">
        Doctors added
      </h2>
      <div className="prg__cards">
        <div className="prg__card">
          <span className="prg__card-n">{added.added}</span>
          <span className="prg__card-l">Doctors added</span>
          {delta && <span className="prg__card-d">{delta}</span>}
        </div>
        <div className="prg__card">
          <span className="prg__card-n">{added.by_hand}</span>
          <span className="prg__card-l">Added by hand</span>
        </div>
        <div className="prg__card">
          <span className="prg__card-n">{added.imported}</span>
          <span className="prg__card-l">From import</span>
        </div>
      </div>
      {added.by_person.length === 0 ? (
        <p className="rep__hint">No doctors were added in this period.</p>
      ) : (
        <div className="prg__scroll">
          <table className="prg__table">
            <thead>
              <tr>
                <th scope="col">Added by</th>
                <th scope="col">Doctors added</th>
                <th scope="col">By hand</th>
                <th scope="col">From import</th>
              </tr>
            </thead>
            <tbody>
              {added.by_person.map((p) => (
                <tr key={p.user_id ?? "unknown"}>
                  <th scope="row">{p.full_name}</th>
                  <td>{p.added}</td>
                  <td>{p.by_hand}</td>
                  <td>{p.imported}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{added.added}</td>
                <td>{added.by_hand}</td>
                <td>{added.imported}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
