import { FabricCountSelect } from '../controls/FabricCountSelect';

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
      <label htmlFor="import-aida">Fabric count
        <FabricCountSelect id="import-aida" value={Number(aida)} onChange={(count) => onAida(String(count))} />
      </label>
    </>
  );
}
