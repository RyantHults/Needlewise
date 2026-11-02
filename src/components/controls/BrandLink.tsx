import { Link } from 'react-router-dom';

export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">✣</span>;
}

export function BrandLink() {
  return (
    <Link className="brand" to="/" aria-label="Needlewise home">
      <BrandMark /><span>Needlewise</span>
    </Link>
  );
}
