/** Three sheets with an upward arrow; they fan out when a drop area is hovered or dragged over. */
export function DocumentArt() {
  return (
    <svg className="document-art" viewBox="0 0 112 104" fill="none" aria-hidden="true">
      <g className="document-art-back">
        <path d="M23 20h41l15 15v53a5 5 0 0 1-5 5H23a5 5 0 0 1-5-5V25a5 5 0 0 1 5-5Z" />
        <path d="M30 43h29M30 53h33M30 63h23" />
      </g>
      <g className="document-art-middle">
        <path d="M39 9h34l17 17v57a5 5 0 0 1-5 5H39a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5Z" />
        <path d="M73 9v13a4 4 0 0 0 4 4h13" />
      </g>
      <g className="document-art-front">
        <path d="M31 14h35l17 17v57a5 5 0 0 1-5 5H31a5 5 0 0 1-5-5V19a5 5 0 0 1 5-5Z" />
        <path className="document-art-fold" d="M66 14v13a4 4 0 0 0 4 4h13" />
        <path className="document-art-line" d="M38 69h31M38 77h21" />
        <path className="document-art-arrow" d="M54 56V39m-7 7 7-7 7 7" />
      </g>
    </svg>
  );
}
