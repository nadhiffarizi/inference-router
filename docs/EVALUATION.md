## A/B comparison — 30 held-out Bitext cases through the gateway

Config A = openrouter-tier-a pinned · Config B = openrouter-tier-b pinned · run at 2026-10-03T11:26Z

| metric | A | B | better |
|---|---|---|---|
| intent accuracy | 87% | 87% | — |
| refusal rate | 0% | 0% | — |
| error rate | 0% | 0% | — |
| avg latency (ms) | 506 | 1569 | A |
| p95 latency (ms) | 757 | 2132 | A |
| total cost (USD) | 0.00383 | 0.04449 | A |
| avg groundedness (1–5) | 3.37 | 4.10 | B |

## Per-case detail

| question | expected intent | A → intent | B → intent |
|---|---|---|---|
| can you help me cancelling purchase {{Order Number}}? | cancel_order | cancel_order | cancel_order |
| I want to pudate purchase {{Order Number}}, can you help me? | change_order | cancel_order | cancel_order |
| I have a trouble trying to modify my address | change_shipping_address | set_up_shipping_address | set_up_shipping_address |
| i dont know how to see the termination charge | check_cancellation_fee | check_cancellation_fee | check_cancellation_fee |
| seeing invoices from {{Person Name}} | check_invoice | check_invoice | check_invoice |
| I want to check what payment options you accept | check_payment_methods | check_payment_methods | check_payment_methods |
| help seeing in what situations can I ask to be refunded | check_refund_policy | check_refund_policy | check_refund_policy |
| I do not know how to lodge a complaint | complaint | complaint | complaint |
| uhave a free number to talk to customer support | contact_customer_service | contact_customer_service | contact_customer_service |
| what do I need todo to speak with somebody? | contact_human_agent | contact_human_agent | contact_human_agent |
| tell me more about opening premium accounts | create_account | create_account | create_account |
| I need information about the removal of a premium account | delete_account | delete_account | delete_account |
| is it possible to order from {{Delivery Country}} | delivery_options | delivery_options | delivery_options |
| how can I see when my delivery is going to arrive? | delivery_period | delivery_period | delivery_period |
| change data on {{Account Type}} account | edit_account | switch_account | switch_account |
| assistance downloading my invoices from {{Person Name}} | get_invoice | check_invoice | check_invoice |
| i want assistance requesting a compnesation of my money | get_refund | get_refund | get_refund |
| wanna sign up too the company newsletter i need help | newsletter_subscription | newsletter_subscription | newsletter_subscription |
| I don't know how I can report an error with payment | payment_issue | payment_issue | payment_issue |
| where do i earn several articles | place_order | place_order | place_order |
| how to recove the pin of my profile | recover_password | recover_password | recover_password |
| i need assistance reporting problems with a sign-up | registration_problems | registration_problems | registration_problems |
| uhave a way to leave an opinion for ur products | review | review | review |
| support entering a new shipping address | set_up_shipping_address | set_up_shipping_address | set_up_shipping_address |
| i dont know how to change to the platinum account | switch_account | switch_account | switch_account |
| i try to check the status of order {{Order Number}} | track_order | track_order | track_order |
| need to check if there are any updates on my reimbursement | track_refund | track_refund | track_refund |
| I want help to cancel order {{Order Number}} | cancel_order | cancel_order | cancel_order |
| I am trying to switch several bloody items of order {{Order  | change_order | change_order | change_order |
| I want assistance trying to change my shipping address | change_shipping_address | change_shipping_address | change_shipping_address |
