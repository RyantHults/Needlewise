import { Link } from 'react-router-dom';

export function BrandLink() {
  return (
    <Link className="brand" to="/" aria-label="Needlewise home">
      <span className="brand-mark" aria-hidden="true">✣</span><span>Needlewise</span>
    </Link>
  );
}
