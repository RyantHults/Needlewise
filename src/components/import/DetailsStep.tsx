export const IMPORT_AIDA_COUNTS = [11, 14, 16, 18, 22] as const;

interface Props {
  title: string;
  aida: string;
  onTitle: (value: string) => void;
  onAida: (value: string) => void;
}

export function DetailsStep({ title, aida, onTitle, onAida }: Props) {
  return (
    <>
      <label htmlFor="import-title">Title<input id="import-title" value={title} onChange={(event) => onTitle(event.target.value)} /></label>
      <label htmlFor="import-aida">Aida count
        <select id="import-aida" value={aida} onChange={(event) => onAida(event.target.value)}>
          {IMPORT_AIDA_COUNTS.map((count) => <option key={count}>{count}</option>)}
        </select>
      </label>
    </>
  );
}
