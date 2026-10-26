import threeD from "../../assets/ui-icons/3d.svg";
import color from "../../assets/ui-icons/color.svg";
import deleteIcon from "../../assets/ui-icons/delete.svg";
import download from "../../assets/ui-icons/download.svg";
import duplicate from "../../assets/ui-icons/duplicate.svg";
import fittopage from "../../assets/ui-icons/fittopage.svg";
import grayscale from "../../assets/ui-icons/grayscale.svg";
import merge from "../../assets/ui-icons/merge.svg";
import redo from "../../assets/ui-icons/redo.svg";
import renameOutline from "../../assets/ui-icons/rename-outline.svg";
import settings from "../../assets/ui-icons/settings.svg";
import shapes from "../../assets/ui-icons/shapes.svg";
import symbol from "../../assets/ui-icons/symbol.svg";
import undo from "../../assets/ui-icons/undo.svg";
import zoomIn from "../../assets/ui-icons/zoom-in.svg";
import zoomOut from "../../assets/ui-icons/zoom-out.svg";

const ICONS = {
  "3d": threeD,
  color,
  delete: deleteIcon,
  download,
  duplicate,
  fittopage,
  grayscale,
  merge,
  redo,
  "rename-outline": renameOutline,
  settings,
  shapes,
  symbol,
  undo,
  "zoom-in": zoomIn,
  "zoom-out": zoomOut,
};

export type IconName = keyof typeof ICONS;

/** A UI icon drawn as a mask over `currentColor`, so it follows the surrounding text colour. Decorative: name the button. */
export function Icon({ name }: { name: IconName }) {
  // Vite inlines a small svg as a data URI that holds raw spaces and quotes, which an unquoted url() rejects.
  const mask = `url(${JSON.stringify(ICONS[name])})`;
  return <span className="ui-icon" style={{ maskImage: mask, WebkitMaskImage: mask }} aria-hidden="true" />;
}
