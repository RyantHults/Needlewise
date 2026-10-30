import threeD from "../../assets/ui-icons/3d.svg";
import color from "../../assets/ui-icons/color.svg";
import deleteIcon from "../../assets/ui-icons/delete.svg";
import download from "../../assets/ui-icons/download.svg";
import duplicate from "../../assets/ui-icons/duplicate.svg";
import fittopage from "../../assets/ui-icons/fittopage.svg";
import folder from "../../assets/ui-icons/folder.svg";
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
import pan from "../../assets/editor-tools/pan.svg";
import select from "../../assets/editor-tools/select.svg";
import selectOval from "../../assets/editor-tools/select-oval.svg";
import lasso from "../../assets/editor-tools/lasso.svg";
import stitch from "../../assets/editor-tools/stitch.svg";
import backstitch from "../../assets/editor-tools/backstitch.svg";
import eraser from "../../assets/editor-tools/eraser.svg";
import paintBucket from "../../assets/editor-tools/paint-bucket.svg";
import eyedropper from "../../assets/editor-tools/eyedropper.svg";
import focus from "../../assets/editor-tools/focus.svg";
import mark from "../../assets/editor-tools/mark.svg";

const ICONS = {
  "3d": threeD,
  color,
  delete: deleteIcon,
  download,
  duplicate,
  fittopage,
  folder,
  grayscale,
  merge,
  redo,
  "rename-outline": renameOutline,
  settings,
  shapes,
  symbol,
  undo,
  "zoom-in": zoomIn,
  pan,
  select,
  "select-oval": selectOval,
  lasso,
  stitch,
  backstitch,
  eraser,
  "paint-bucket": paintBucket,
  eyedropper,
  focus,
  mark,
  "zoom-out": zoomOut,
};

export type IconName = keyof typeof ICONS;

/** A UI icon drawn as a mask over `currentColor`, so it follows the surrounding text colour. Decorative: name the button. */
export function Icon({ name }: { name: IconName }) {
  // Vite inlines a small svg as a data URI that holds raw spaces and quotes, which an unquoted url() rejects.
  const mask = `url(${JSON.stringify(ICONS[name])})`;
  return <span className="ui-icon" data-icon={name} style={{ maskImage: mask, WebkitMaskImage: mask }} aria-hidden="true" />;
}
