import type { CadenceApi } from "../shared/types";

declare global {
  interface Window {
    cadence: CadenceApi;
  }

  namespace JSX {
    interface IntrinsicElements {
      "braccato-lyrics": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        "current-time"?: number;
        playing?: boolean;
        layout?: "scroll" | "stage";
        source?: string;
      };
    }
  }
}

export {};
