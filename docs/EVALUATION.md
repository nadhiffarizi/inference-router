## A/B comparison — 30 held-out Bitext cases through the gateway

Config A = openrouter-tier-a pinned · Config B = openrouter-tier-b pinned · run at 2026-10-03T11:20Z

| metric | A | B | better |
|---|---|---|---|
| intent accuracy | 0% | 0% | A |
| refusal rate | 7% | 7% | — |
| error rate | 93% | 93% | A |
| avg latency (ms) | 1 | 1 | A |
| p95 latency (ms) | 1 | 1 | A |
| total cost (USD) | 0.00000 | 0.00000 | A |
| avg groundedness (1–5) | n/a | n/a | B |

## Per-case detail

| question | expected intent | A → intent | B → intent |
|---|---|---|---|
| I do not want this item, cancel order {{Order Number}} | cancel_order | ERR | ERR |
| want assistance to delete an item from orer {{Order Number}} | change_order | ERR | ERR |
| I have a trouble trying to change my delivery address | change_shipping_address | ERR | ERR |
| I have to see the termination fee | check_cancellation_fee | ERR | ERR |
| checking bill from {{Person Name}} | check_invoice | ERR | ERR |
| I have to see what payment options are available | check_payment_methods | ERR | ERR |
| I wwould like to see your damn money back policy, help me | check_refund_policy | ERR | ERR |
| can you help me making a claim against your company? | complaint | ERR | ERR |
| i have got to contact customer support how can i do it | contact_customer_service | ERR | ERR |
| help talking  with a live agent | contact_human_agent | ERR | ERR |
| open a {{Account Type}} account | create_account | ERR | ERR |
| i want assistance to delete the {{Account Type}} account | delete_account | ERR | ERR |
| help me checking what delivery methods I have | delivery_options | ERR | ERR |
| I want assistance checking when my order is going to arrive | delivery_period | ERR | ERR |
| I have to correct the info included on my profile, help me | edit_account | ERR | ERR |
| help me to download my goddamn invoices from {{Person Name}} | get_invoice | ERR | ERR |
| I do not know how to obtain rebates of money | get_refund | ERR | ERR |
| I need to unsubscribe from the newsletter, how can I do it? | newsletter_subscription | ERR | ERR |
| assistance to solve a fucking payment error | payment_issue | ERR | ERR |
| I don't know what to do to order several items | place_order | ERR | ERR |
| I cannot retrieve my user account PIN code | recover_password | ERR | ERR |
| need support with my signup | registration_problems | refused | refused |
| can you help me to send feedback about your company? | review | ERR | ERR |
| is it possible to enter a new shipping address? | set_up_shipping_address | ERR | ERR |
| wanna use the {{Account Type}} account i need help | switch_account | ERR | ERR |
| show me order {{Order Number}} status | track_order | ERR | ERR |
| where can I see if there is anything new on the restitution? | track_refund | ERR | ERR |
| I want to cancle purchase {{Order Number}} | cancel_order | ERR | ERR |
| changing purchase {{Order Number}} | change_order | refused | refused |
| i have put the old address by mistkae help me modifying it | change_shipping_address | ERR | ERR |
