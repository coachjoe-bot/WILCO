// Stripe checkout island — split out of App.jsx so @stripe/react-stripe-js only
// downloads when checkout actually reaches the card form. Most sessions never
// open payment, so this trims the main bundle every boot pays to parse.
// Styling comes in via props (errColor/btnBase) so this chunk stays free of the
// App.jsx theme tokens.
import { useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";

// Inner form — lives inside <Elements> so it can use the Stripe hooks. Collects the
// card via PaymentElement and confirms the SetupIntent (trial/$0) or PaymentIntent
// (real first charge) in-app, no redirect.
function PayForm({confirmMode, payLabel, onSuccess, errColor, btnBase}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting,setSubmitting] = useState(false);
  const [error,setError] = useState("");

  const submit = async () => {
    if(!stripe||!elements||submitting) return;
    setSubmitting(true); setError("");
    const opts = { elements, confirmParams: { return_url: window.location.href }, redirect: "if_required" };
    let result;
    try {
      result = confirmMode==="payment" ? await stripe.confirmPayment(opts) : await stripe.confirmSetup(opts);
    } catch(e){ setError("Something went wrong. Try again."); setSubmitting(false); return; }
    if(result.error){
      setError(result.error.message || "Payment failed. Check your card details and try again.");
      setSubmitting(false);
      return;
    }
    onSuccess();
  };

  return (
    <div>
      <PaymentElement options={{layout:"tabs"}}/>
      {error && <div style={{color:errColor,fontSize:12,marginTop:10,textAlign:"center"}}>{error}</div>}
      <button onClick={submit} disabled={!stripe||submitting}
        style={{...btnBase,opacity:(!stripe||submitting)?0.7:1,cursor:(!stripe||submitting)?"not-allowed":"pointer"}}>
        {submitting ? "Processing..." : payLabel}
      </button>
    </div>
  );
}

export default function StripePayBlock({stripeObj, options, confirmMode, payLabel, onSuccess, errColor, btnBase}) {
  return (
    <Elements stripe={stripeObj} options={options}>
      <PayForm confirmMode={confirmMode} payLabel={payLabel} onSuccess={onSuccess} errColor={errColor} btnBase={btnBase}/>
    </Elements>
  );
}
