import "react";

// Teach JSX about <stripe-checkout> and its declarative input attributes.
// Outputs (status/amount/error/…) are NOT props — they are read reactively
// via @wc-bindable/react's useWcBindable().
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "stripe-checkout": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          mode?: "payment" | "setup";
          "publishable-key"?: string;
          "amount-value"?: string | number;
          "amount-currency"?: string;
          "customer-id"?: string;
          "return-url"?: string;
        },
        HTMLElement
      >;
    }
  }
}
