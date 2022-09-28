const Wallet = require('../../../models/Wallet')
const { isActiveWallet } = require("../util");
const { stripe } = require('../../../config/stripe')


const RETRY_WEBHOOK_STATUS_CODE = 418
/**
 * Used to specify the percentage of job amount paid to deployee when a deployer cancels out of the specified deadline
 */
const PAYMENT_PERCENTAGE_ON_CANCEL = 0.5 // 50%

const CALLBACK_URL = {
    // SUCCESS: process.env.BASE_HOST_URI + '/api/payments/session/success',
    SUCCESS: 'https://stripe.com/success?sc_checkout=success',
    CANCELLED: 'https://stripe.com/cancel?sc_checkout=cancel',
}

const TRANSACTION_STATUS = {
    PENDING: 0,
    SUCCESS: 1,
    FAILED: 2,
    DECLINED: 3,
    UNCAPTURED: 4
}

/**
 * Contains logic for communicating with Stripe for payment processing.
 * This class abstracts the details required to initiate and manage payments.
 * 
 * We will require methods for the following:
 * -  Setup payment method.
 * -  Make payment.
 * -  Onboard deployee to receive payment.
 */
class Payment {

    static async createAccount({
        country = 'US',
        default_currency = 'USD',
        email, phone,
        first_name, last_name,
        maiden_name = '',
        schedule = {
            delay_days: '2',
            interval: 'weekly',
            weekly_anchor: 'monday'
        }
    }) {
        return await stripe.accounts.create({
            business_type: 'individual',
            business_profile: {
                product_description: `${process.env.APP_NAME} Stripe account`,
                url: process.env.APP_URL,
                name: `${first_name} ${last_name}`,
                mcc: 1520, // general_services
            },
            country,
            default_currency,
            email,
            capabilities: {
                card_payments: {
                    requested: true
                },
                transfers: {
                    requested: true
                }
            },
            individual: {
                first_name,
                last_name,
                maiden_name,
                email,
                phone,
            },
            type: 'express',
            settings: {
                payouts: {
                    debit_negative_balances: true,
                    // By default, all accounts have 2 weeks payout schedule and the user will have to requet for payment before receiving funds instantly
                    schedule: schedule || {
                        delay_days: '2',
                        interval: 'weekly',
                        weekly_anchor: 'monday'
                    }
                }
            }
        })
    }

    static async deleteAccount(account) {
        return await stripe.accounts.del(account)
    }

    static async createCustomer({ email, phone, first_name, last_name }) {
        return await stripe.customers.create({
            description: `${process.env.APP_NAME} customer created by platform`,
            email,
            phone,
            name: `${first_name} ${last_name}`,
        })
    }

    static async deleteCustomer(customer) {
        return await stripe.customers.del(customer)
    }


    /**
     * 
     * @param {*} account Stripe account to generate a link for
     * @param {*} refresh_url URL called to request a new account link
     * @param {*} return_url URL called when stripe onboarding form is submitted
     */
    static async generateAccountLink(account, refresh_url = CALLBACK_URL.CANCELLED, return_url = CALLBACK_URL.SUCCESS) {
        const link = await stripe.accountLinks.create({
            account,
            refresh_url,
            return_url,
            type: 'account_onboarding'
        })

        return link.url
    }

    static async generateDashboardLink(account) {
        const link = await stripe.accounts.createLoginLink(account);

        return link.url
    }

    static async createSetupCheckoutSession(customerID, payment_method_types = ['card']) {
        const session = await stripe.checkout.sessions.create({
            mode: 'setup',
            cancel_url: CALLBACK_URL.CANCELLED,
            success_url: CALLBACK_URL.SUCCESS,
            payment_method_types,
            customer: customerID,
        })
        return session
    }

    static async refundPayment(payment_intent, { amount }) {
        const refund = await stripe.refunds.create({
            amount,
            refund_application_fee: false,
            reverse_transfer: true,
            payment_intent
        })

        console.log(`Refund ${refund.id}, ${amount} for payment intent ${payment_intent}`, `Application fee not refunded`, `Reverse_transfer (if false, refund will be from platform's balance): ${refund.transfer_reversal}`)
    }

    /**
     * Initiates a direct payment for a product on this application.
     * This will be used for collecting any form of payment that does not concern a connected account.
     * 
     * For this, there is no hold and payment is made immediately.
     * 
     * @param {*} paymentParams Parameters containing details used in creating pyment.
     */
    static async makePayment({
        payment_method,
        customer,
        amount, description = `Payment for ${process.env.APP_NAME}`, currency = 'usd' }) {
        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency,
            confirm: true,
            customer,
            off_session: 'one_off',
            payment_method,
            description,
            capture_method: 'automatic',
            error_on_requires_action: true,
            metadata: { gigChasersPurchase: true, isApplication: true }
        })

        console.log(`Made payment: ${paymentIntent.id}`, `${paymentIntent.customer} paying ${paymentIntent.amount}`)
        return paymentIntent
    }

    static async makeAccountPayment({
        payment_method,
        customer, accountID,
        applicationFee,
        amount, description = `Payment for ${process.env.APP_NAME}`, currency = 'usd' }) {
        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency,
            confirm: true,
            customer,
            off_session: 'one_off',
            payment_method,
            description,
            capture_method: 'automatic',
            error_on_requires_action: true,
            application_fee_amount: applicationFee,
            transfer_data: { destination: accountID },
            metadata: { gigChasersPurchase: true }
        })

        console.log('Made payment', paymentIntent.id, `${paymentIntent.customer} paying ${paymentIntent.amount} to ${paymentIntent.transfer_data?.destination}`)
        return paymentIntent
    }

    static async authorizeFundsForPayment({
        payment_method,
        customer, accountID,
        applicationFee,
        amount, description = `Payment for ${process.env.APP_NAME}`, currency = 'usd' }) {
        
        console.log('About to authorize funds for later capture', `${customer} paying ${amount} to ${accountID}`)
        // Use this to work with invoices instead of intents
        //  await stripe.invoiceItems.create({
        //     customer,
        //     amount,
        //     currency,
        //     description,
        // })
        // await stripe.invoices.create({
        //     auto_advance: true,
        //     application_fee_amount: applicationFee,
        //     customer,
        //     metadata: { gigChasersPurchase: true },
        //     transfer_data: { destination: accountID },
        //     default_payment_method: payment_method
        // })
        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency,
            confirm: true,
            customer,
            off_session: 'one_off',
            payment_method,
            description,
            capture_method: 'manual',
            error_on_requires_action: true,
            application_fee_amount: applicationFee,
            transfer_data: { destination: accountID },
            metadata: { gigChasersPurchase: true }
        })

        console.log('Authorized funds for later capture', paymentIntent.id, `${paymentIntent.customer} paying ${paymentIntent.amount} to ${paymentIntent.transfer_data?.destination}`)
        return paymentIntent
    }

    static async captureforPayment(paymentIntent, { amount, applicationFee }) {
        console.log('Capturing funds for payment - start', paymentIntent)

        paymentIntent = await stripe.paymentIntents.capture(paymentIntent, {
            amount_to_capture: amount,
            application_fee_amount: applicationFee,
        })

        console.log('Captured funds for payment - end', paymentIntent.id, `${paymentIntent.customer} paid ${paymentIntent.amount} to ${paymentIntent.transfer_data?.destination}`)
    }

    /**
     * Setup a manual payout.
     * 
     * Stripe charges for billing a connected account [Stripe billing reference](https://stripe.com/connect/pricing)
     * 
     * @param {*} account
     *     @param {string} account The stripe account receiving payout
     *     @param {string} user The Gigchasers ID for user initiating payout
     *     @param {string} destination Identity of the account to send payout
     *     @param {string} currency
     *     @param {number} amount 
     *     @param {boolean} isBank True if the specified payout destination is a bank or a card
     */
    static async payout({ account, user, destination, currency = 'usd', amount, isBank }) {
        console.log(`Initiating payout of ${amount} to ${destination} from ${account}`)

        // Minimum payout is $10
        if (amount <= 1000) {
            throw new Error('Enter an amount more than $10')
        }

        const wallet = await Wallet.findOneAndUpdate({ user, currency },
            {
                user,
                currency,
            },
            {
                upsert: true,
                new: true,
                rawResult: false,
                useFindAndModify: false,
            },
        )
        if (!(await isActiveWallet(wallet))) {
            throw new Error('Wallet is not active')
        }

        // Confirm if the wallet is funded
        if ((wallet.value - wallet.pendingPayout) < amount) {
            throw new Error('Insufficient funds available for payout')
        }

        // Check balance to confirm funds exist for payout
        const balance = await stripe.balance.retrieve({
            stripeAccount: account
        })

        // Get available balances
        const balanceAmount = balance.available.reduce((prev, current) => {
            if (current.currency === currency) {
                prev = prev + (isBank ? current.source_types.bank_account : current.source_types.card)
            }
            return prev
        }, 0)

        if (balanceAmount < amount) {
            throw new Error('Insufficient funds available for payout')
        }

        // For each payout, a service fee of 12.5% is charged.
        // Collect an debit on the account
        const computedPayoutFee = Math.ceil(amount * 0.125)
        const charge = await stripe.charges.create({
            amount: computedPayoutFee,
            currency,
            source: account,
        })
        console.log(`Created debit for payout of ${amount}, charge ID is ${charge.id}, debit is ${computedPayoutFee}`)

        // Initiate payout
        const payout = await stripe.payouts.create({
            amount: amount - computedPayoutFee,
            currency,
            destination
        }, { stripeAccount: account });
        console.log(`Initiated payout (${payout.id}) funds of ${amount - computedPayoutFee} ${currency}`)
    }

    static async cancelAuthorizedPayment(intent) {
        return await stripe.paymentIntents.cancel(intent)
    }

    static async deletePaymentMethod(method) {
        return await stripe.paymentMethods.detach(method)
    }

    static async setDefaultPaymentMethod(default_payment_method, customerID) {
        await stripe.customers.update(customerID, {
            invoice_settings: { default_payment_method }
        })
    }
}

module.exports = { RETRY_WEBHOOK_STATUS_CODE, PAYMENT_PERCENTAGE_ON_CANCEL, TRANSACTION_STATUS, Payment }
