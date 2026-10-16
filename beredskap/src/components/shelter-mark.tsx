/** The Swedish shelter sign (square with a triangle), drawn like the public map's icon. */
export function ShelterMark(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round" />
      <path d="M16 9 24 23H8Z" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round" />
    </svg>
  );
}
