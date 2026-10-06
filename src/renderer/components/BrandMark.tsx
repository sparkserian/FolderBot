import iconUrl from "../assets/app-icon-64.png";

export function BrandMark({ size = 18 }: { size?: number }) {
  return <img className="brand-mark" src={iconUrl} width={size} height={size} alt="" />;
}
