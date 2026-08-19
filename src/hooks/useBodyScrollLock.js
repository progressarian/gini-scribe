import { useEffect } from "react";

let locks = 0;
let restore = null;

const lock = () => {
  if (locks++ > 0) return;
  const { body, documentElement: html } = document;
  restore = {
    bodyOverflow: body.style.overflow,
    bodyPaddingRight: body.style.paddingRight,
    htmlOverflow: html.style.overflow,
  };
  const gutter = window.innerWidth - html.clientWidth;
  html.style.overflow = "hidden";
  body.style.overflow = "hidden";
  if (gutter > 0) body.style.paddingRight = `${gutter}px`;
};

const unlock = () => {
  if (--locks > 0) return;
  locks = 0;
  if (!restore) return;
  document.documentElement.style.overflow = restore.htmlOverflow;
  document.body.style.overflow = restore.bodyOverflow;
  document.body.style.paddingRight = restore.bodyPaddingRight;
  restore = null;
};

export default function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    lock();
    return unlock;
  }, [active]);
}
