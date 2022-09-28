const mongoose = require('mongoose')
const PaymentAccount = require('../../../models/PaymentAccount')
const PaymentMethod = require('../../../models/PaymentMethod')
const PaymentTransaction = require('../../../models/PaymentTransaction')
const PayoutAccount = require('../../../models/PayoutAccount')
const PayoutTransaction = require('../../../models/PayoutTransaction')
const Wallet = require('../../../models/Wallet')
const { generateInvoiceAndSave } = require("../util");
const { stripe } = require('../../../config/stripe')
const Invoice = require('../../../models/Invoice')
const JobPayment = require('../../../models/JobPayment')
const NotificationController = require("./notification");
const { TRANSACTION_STATUS, RETRY_WEBHOOK_STATUS_CODE } = require('./payments')

class Webhook
{
    static acceptedEvents = [
        // This indicates a payment is successful, subscription or payment.
        'payment_intent.succeeded', // This is for credit purchase alone as it does not generate any invoice
        // Indicates funds have been authorized and ready to be captured.
        // This will create a transaction with status as 'captured'.
        'payment_intent.amount_capturable_updated',
        // This and payment_intent.payment_failed indicate failed payment intent
        'payment_intent.requires_action',
        'payment_intent.payment_failed',

        // Updates to payment method
        'payment_method.attached',
        'payment_method.detached',
        'payment_method.updated',
        'payment_method.automatically_updated',
        'account.updated',
        'account.external_account.created',
        'account.external_account.deleted',
        'account.external_account.updated',
        // 'person.created',
        'account.application.deauthorized',
        'balance.available',
        'payout.paid',
        'payout.failed',
        'payout.canceled',
        'payout.created',
        'payout.updated',


        'charge.expired', // For expired uncaptured funds
    ]
    event

    constructor(event, sig, secret = undefined)
    {
        if (!secret)
        {
            secret = process.env.NODE_ENV === 'production' ? process.env.STRIPE_ENDPOINT_SECRET : process.env.STRIPE_ENDPOINT_SECRET_DEV
        }

        this.event = stripe.webhooks.constructEvent(event, sig, secret)
    }

    async handle()
    {
        switch (this.event.type)
        {
            // - TESTED
            // Updates to payment method
            case 'payment_method.updated':
            case 'payment_method.automatically_updated':
            case 'payment_method.attached':
                let paymentMethod = this.event.data.object
                await this.setupPaymentMethod(paymentMethod)
                break
            case 'payment_method.detached':
                let paymentMethodRemoved = this.event.data.object
                await this.removePaymentMethod(paymentMethodRemoved)
                break
            case 'balance.available':
                let balance = this.event.data.object
                // This event (balance.available) is triggerred for both the platform and connected accounts.
                // Check if the event is triggered for a connect account as that is what we care about
                if (this.event.account)
                {
                    await this.availableBalance(this.event.account, balance)
                } else
                {
                    console.log(`Skipped processing balance (account: ${this.event.account}, eventID: ${this.event.id}) for platform account`)
                }
                break
            // - END TESTED
            // This indicates a payment is successful
            case 'payment_intent.succeeded':
                let paymentIntent = this.event.data.object

                // Ensure purchase is expected
                if (paymentIntent.metadata.gigChasersPurchase)
                {
                    await this.handlePayment(paymentIntent)
                } else
                {
                    console.log(`Payment intent (${paymentIntent.id}) succeeded without metadata`)
                }
                break
            case 'payment_intent.amount_capturable_updated':
                let authorizedIntent = this.event.data.object
                if (authorizedIntent.metadata.gigChasersPurchase)
                {
                    await this.authorizedPayment(authorizedIntent)
                } else
                {
                    console.log(`Payment intent (${authorizedIntent.id}) amount captured without metadata`)
                }
                break
            case 'payment_intent.requires_action':
            case 'payment_intent.payment_failed':
                let failedPaymentIntent = this.event.data.object
                if (failedPaymentIntent.metadata.gigChasersPurchase)
                {
                    await this.handleFailedPayment(failedPaymentIntent)
                } else
                {
                    console.log(`Payment intent (${failedPaymentIntent.id}) failed without metadata`)
                }
                break
            case 'payment_intent.canceled':
                let cancelledPaymentIntent = this.event.data.object
                if (cancelledPaymentIntent.metadata.gigChasersPurchase)
                {
                    await this.handleCancelledPayment(cancelledPaymentIntent)
                } else
                {
                    console.log(`Payment intent (${cancelledPaymentIntent.id}) failed without metadata`)
                }
                break
            case 'account.updated':
                let connectAccount = this.event.data.object
                await this.activateAccount(connectAccount)
                break
            case 'account.external_account.created':
                let externalAccount = this.event.data.object
                await this.configureExternalAccount(this.event.account, externalAccount)
                break
            case 'account.external_account.updated':
                let updatedExternalAccount = this.event.data.object
                await this.updateExternalAccount(this.event.account, updatedExternalAccount)
                break
            case 'account.external_account.deleted':
                let deactivatedExternalAccount = this.event.data.object
                await this.removeExternalAccount(this.event.account, deactivatedExternalAccount)
                break
            case 'account.application.deauthorized':
                let deactivatedAccount = this.event.data.object
                await this.deauthorizeAccount(deactivatedAccount)
                break
            case 'payout.failed':
            case 'payout.canceled':
                let failedPayout = this.event.data.object
                await this.payoutFailed(this.event.account, failedPayout)
                break
            case 'payout.paid':
                let successPayout = this.event.data.object
                await this.payoutSuccess(this.event.account, successPayout)
                break
            case 'payout.created':
            case 'payout.updated':
                let newPayout = this.event.data.object
                await this.payoutCreated(this.event.account, newPayout)
                break
            default:
                throw new Error("Unhandled event type specified!")
        }
    }

    /**
     * This is called to fulfill a successful payment transaction.
     * There must be an existing payment transaction in the database before processing.
     * 
     * @param {*} info payment intent from Stripe event
     */
    async handlePayment(info)
    {
        let accounts = await PaymentAccount.find({ stripeCustomerID: info.customer })
        const session = await mongoose.startSession()

        try
        {
            if (accounts.length !== 1)
            {
                throw new Error("Customer must exist and you cannot have multiple accounts with same customer identity!")
            }
            const txn = await PaymentTransaction.findOne({ stripePaymentIntentID: info.id, sender: accounts[0].user })
            if (!txn)
            {
                throw new Error("Transaction does not exist!")
            }

            if (info.status === 'succeeded')
            {
                if (info.metadata.isApplication)
                {
                    // Payment is a direct charge for the platform
                    await session.withTransaction(async () =>
                    {
                        // Payment is to a connected (deployee) account.
                        // Add funds to the deployee's wallet and complete the transaction.
                        let recipient = await PaymentAccount.findOne({ stripeAccountID: info.transfer_data.destination })
                        if (!recipient)
                        {
                            throw new Error("Recipient does not exist!")
                        }
                        const updatedInvoice = await Invoice.findOne({ transactionID: txn.id })
                        if (updatedInvoice)
                        {
                            const update = {
                                amount: info.amount - txn.tax,
                                tax: txn.tax,
                                total: info.amount,
                                jobStatus: 'Complete',
                                description: txn.description,
                            }
                            const savedFile = await generateInvoiceAndSave({ ...updatedInvoice, ...update })
                            update.invoiceURL = savedFile.Location
                            updatedInvoice.updateOne(update, {
                                new: true,
                                rawResult: true,
                                session
                            })
                        }
                        await txn.updateOne({ status: TRANSACTION_STATUS.SUCCESS }, { session })
                    })
                } else
                {
                    await session.withTransaction(async () =>
                    {
                        // Payment is to a connected (deployee) account.
                        // Add funds to the deployee's wallet and complete the transaction.
                        let recipient = await PaymentAccount.findOne({ stripeAccountID: info.transfer_data.destination })
                        if (!recipient)
                        {
                            throw new Error("Recipient does not exist!")
                        }
                        const jobPayment = await JobPayment.findOne({ paymentID: txn.id })
                        const updatedInvoice = await Invoice.findOne({ transactionID: txn.id })
                        if (!jobPayment)
                        {
                            throw new Error("Job payment details not found!")
                        }

                        if (updatedInvoice)
                        {
                            const update = {
                                amount: info.amount - jobPayment.deployerCharge - txn.tax,
                                tax: txn.tax,
                                total: info.amount,
                                jobStatus: 'Complete',
                                description: txn.description,
                            }
                            const savedFile = await generateInvoiceAndSave({ ...updatedInvoice, ...update })
                            update.invoiceURL = savedFile.Location
                            updatedInvoice.updateOne(update, { session })
                        }
                        await txn.updateOne({ status: TRANSACTION_STATUS.SUCCESS }, { session })
                    })
                }
            }
            await new Promise((resolve) =>
            {
                session.endSession(resolve)
            });
        } catch (e)
        {
            session.endSession()
            console.log(`Failed to process payment intent ${info.id} for ${info.amount}`, e)
            //TODO: Refund payment if an error occurred
            // Payment.refundPayment(intent.id, { refund_application_fee: true, reverse_transfer: true })
            return Promise.reject({ status: 418, message: e.message }) // Retry intent
        }
    }

    async authorizedPayment(info)
    {
        try
        {
            let accounts = await PaymentAccount.find({ stripeCustomerID: info.customer })

            if (accounts.length !== 1)
            {
                throw new Error("Customer must exist and you cannot have multiple accounts with same customer identity!")
            }
            const price = info.amount_capturable
            const txn = await PaymentTransaction.findOne({ stripePaymentIntentID: info.id, sender: accounts[0].user })
            if (!txn)
            {
                throw new Error("Transaction does not exist!")
            }

            if (!info.metadata.isApplication)
            {
                // Payment is to a connected (deployee) account.
                // Add funds to the deployee's wallet and complete the transaction.
                let recipient = await PaymentAccount.findOne({ stripeAccountID: info.transfer_data.destination })
                if (!recipient)
                {
                    throw new Error("Recipient does not exist!")
                }

                await txn.updateOne({ status: TRANSACTION_STATUS.UNCAPTURED, amount: price, })

                NotificationController.sendNotification({
                    body: {
                        recipient: accounts[0].user,
                        message: {
                            title: `${process.env.APP_NAME} - Payment Authorized`,
                            body: "Funds have been authorized for your preferred payment method for later capture",
                            data: { type: "paymentauthorize", id: info.id, sender: recipient.user }
                        },
                        passthru: true
                    }
                }).catch(e => console.error(e))
            }
        } catch (e)
        {
            console.log(`Failed to record uncaptured payment intent ${info.id} for ${info.amount_capturable}`, e)
            throw e
        }
    }

    async handleFailedPayment(info)
    {
        try
        {
            let accounts = await PaymentAccount.find({ stripeCustomerID: info.customer })

            if (accounts.length !== 1)
            {
                throw new Error("Customer must exist and you cannot have multiple accounts with same customer identity!")
            }
            const txn = await PaymentTransaction.findOne({ stripePaymentIntentID: info.id, sender: accounts[0].user })
            if (!txn)
            {
                throw new Error("Transaction does not exist!")
            }

            if (info.metadata.isApplication)
            {
                // Payment is a direct charge for the platform
                await txn.updateOne({ status: TRANSACTION_STATUS.FAILED, description: (info.last_payment_error && info.last_payment_error.message) || 'Payment Failed' })
            } else
            {
                // Payment is to a connected (deployee) account.
                // Add funds to the deployee's wallet and complete the transaction.
                let recipient = await PaymentAccount.findOne({ stripeAccountID: info.transfer_data.destination })
                if (!recipient)
                {
                    throw new Error("Recipient does not exist!")
                }

                await Invoice.deleteOne({ transactionID: txn.id })
                await txn.updateOne({ status: TRANSACTION_STATUS.FAILED, description: (info.last_payment_error && info.last_payment_error.message) || 'Payment Failed' })
            }
            console.log(`Notify payment intent failed ${info.id} for ${info.amount}, user: ${accounts[0].user}`, e)
            NotificationController.sendNotification({
                body: {
                    recipient: accounts[0].user,
                    message: {
                        title: `${process.env.APP_NAME} - Payment Failed`,
                        body: txn.description,
                        data: { type: "paymentfail", id: info.id, sender: recipient.user }
                    },
                    passthru: true
                }
            }).catch(e => console.error(e))
        } catch (e)
        {
            console.log(`Payment intent failed ${info.id} for ${info.amount}`, e)
            return Promise.reject({ status: 418, message: e.message }) // Retry intent
        }
    }

    async handleCancelledPayment(info)
    {
        try
        {
            let accounts = await PaymentAccount.find({ stripeCustomerID: info.customer })
            let recipient;
            if (accounts.length !== 1)
            {
                throw new Error("Customer must exist and you cannot have multiple accounts with same customer identity!")
            }
            const txn = await PaymentTransaction.findOne({ stripePaymentIntentID: info.id, sender: accounts[0].user })
            if (!txn)
            {
                throw new Error("Transaction does not exist!")
            }

            if (info.metadata.isApplication)
            {
                // Payment is a direct charge for the platform
                await txn.updateOne({ status: TRANSACTION_STATUS.FAILED, description: info.last_payment_error?.last_payment_error?.message || 'Payment Failed' })
            } else
            {
                // Payment is to a connected (deployee) account.
                // Add funds to the deployee's wallet and complete the transaction.
                recipient = await PaymentAccount.findOne({ stripeAccountID: info.transfer_data.destination })
                if (!recipient)
                {
                    throw new Error("Recipient does not exist!")
                }

                await Invoice.deleteOne({ transactionID: txn.id })
                await txn.updateOne({ status: TRANSACTION_STATUS.FAILED, description: info?.last_payment_error?.message || 'Payment Failed' })
            }
            const usersToNotify = [accounts[0].user];
            if (recipient)
            {
                usersToNotify.push(recipient?.user)
            }
            NotificationController.sendNotification({
                body: {
                    recipient: usersToNotify,
                    message: {
                        title: `${process.env.APP_NAME} - Payment Failed`,
                        body: "Payment was cancelled",
                        data: { type: "paymentcancel", id: info.id, sender: recipient?.user }
                    },
                    passthru: true
                }
            }).catch(e => console.error(e))
        } catch (e)
        {
            console.log(`Payment intent failed ${info.id} for ${info.amount}`, e)
            return Promise.reject({ status: 418, message: e.message }) // Retry intent
        }
    }

    async setupPaymentMethod(method)
    {
        let accounts = await PaymentAccount.find({ stripeCustomerID: method.customer })
        if (accounts.length !== 1)
        {
            throw new Error("Customer must exist and you cannot have multiple accounts with same customer identity!")
        }

        await PaymentMethod.findOneAndUpdate(
            {
                user: accounts[0].user,
                fingerprint: method.card.fingerprint
            },
            {
                stripePaymentMethodID: method.id,
                mask: method.card.last4,
                brand: method.card.brand,
                // The only type currently accepted by design is 'card'
                type: method.type,
                name: method.billing_details.name,
                month: method.card.exp_month,
                year: method.card.exp_year,
                country: method.card.country,
                wallet: method.card.wallet?.type
            },
            {
                upsert: true,
                new: true,
                rawResult: true,
                useFindAndModify: false
            }
        )

        return
    }

    async removePaymentMethod(method)
    {
        // Find the method intended for deletion
        const paymentMethod = await PaymentMethod.findOneAndDelete({ stripePaymentMethodID: method.id })
        if (!paymentMethod)
        {
            console.log("Payment method not found")
            return
        }

        return
    }

    async activateAccount(account)
    {
        let accounts = await PaymentAccount.find({ stripeAccountID: account.id })
        if (accounts.length !== 1)
        {
            throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
        }

        // Only activate if all requirements is complete
        if (account.charges_enabled && (!account.requirements.currently_due || (Array.isArray(account.requirements.currently_due) && account.requirements.currently_due.length < 1)) && account.payouts_enabled)
        {
            await accounts[0].updateOne({ isOnboarded: true, payoutEnabled: true })
        } else
        {
            console.log('Account not ready yet!')
            await accounts[0].updateOne({ isOnboarded: false, payoutEnabled: false })
        }
        return
    }

    async deauthorizeAccount({ account })
    {
        let accounts = await PaymentAccount.find({ stripeAccountID: account })
        if (accounts.length !== 1)
        {
            throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
        }

        await this.removeExternalAccountUser(accounts[0])
        return
    }

    /**
     * @helper
     */
    async removeExternalAccountUser(account)
    {
        await PayoutAccount.deleteMany({ user: account.user })
        // await Wallet.updateMany({ user: account.user })
        await account.updateOne({ stripeAccountID: null, isOnboarded: false })

        return
    }

    async configureExternalAccount(account, extAccount)
    {
        let accounts = await PaymentAccount.find({ stripeAccountID: account })
        if (accounts.length !== 1)
        {
            throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
        }

        await PayoutAccount.findOneAndUpdate(
            {
                user: accounts[0].user,
                stripeExternalAccountID: extAccount.id
            },
            {
                isBank: extAccount.object === 'card' ? false : true,
                mask: extAccount.last4,
                fingerprint: extAccount.fingerprint,
                brand: extAccount.brand,
                type: extAccount.type,
                name: extAccount.name,
                month: extAccount.exp_month,
                year: extAccount.exp_year,
                country: extAccount.country,
                currency: extAccount.currency,
                wallet: extAccount.tokenization_method,
                isDefault: extAccount.default_for_currency,
                bankName: extAccount.bank_name,
                routingNumber: extAccount.routing_number,
                active: extAccount.object === 'bank_account' ? extAccount.status === 'new' ? true : false : true,
            },
            {
                upsert: true,
                new: true,
                rawResult: true,
                useFindAndModify: false
            }
        )

        return
    }

    async updateExternalAccount(account, extAccount)
    {
        let accounts = await PaymentAccount.find({ stripeAccountID: account })
        if (accounts.length !== 1)
        {
            throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
        }

        const update = {
            isBank: extAccount.object === 'card' ? false : true,
            mask: extAccount.last4,
            fingerprint: extAccount.fingerprint,
            brand: extAccount.brand,
            type: extAccount.type,
            name: extAccount.name,
            month: extAccount.exp_month,
            year: extAccount.exp_year,
            country: extAccount.country,
            currency: extAccount.currency,
            wallet: extAccount.tokenization_method,
            isDefault: extAccount.default_for_currency,
            bankName: extAccount.bank_name,
            routingNumber: extAccount.routing_number,
        }
        if (extAccount.object === 'bank_account')
        {
            update.active = extAccount.status === 'new' ? true : false
        }

        await PayoutAccount.findOneAndUpdate(
            {
                user: accounts[0].user,
                stripeExternalAccountID: extAccount.id
            }, update,
            {
                upsert: false,
                new: true,
                rawResult: true,
                useFindAndModify: false
            }
        )

        return
    }

    async removeExternalAccount(account, extAccount)
    {
        let accounts = await PaymentAccount.find({ stripeAccountID: account })
        if (accounts.length !== 1)
        {
            throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
        }

        await PayoutAccount.findOneAndRemove(
            {
                user: accounts[0].user,
                stripeExternalAccountID: extAccount.id
            })

        return
    }

    async payoutCreated(account, payout)
    {
        const session = await mongoose.startSession()
        try
        {
            let accounts = await PaymentAccount.find({ stripeAccountID: account })
            if (accounts.length !== 1)
            {
                throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
            }

            // Get PayoutAccount
            const payoutAccount = await PayoutAccount.findOne({
                user: accounts[0].user,
                stripeExternalAccountID: payout.destination
            })
            if (!payoutAccount)
            {
                await Promise.reject({ message: 'External account not recognized', code: RETRY_WEBHOOK_STATUS_CODE })
            }

            // Get wallet
            const wallet = await Wallet.findOneAndUpdate({ user: accounts[0].user, currency: payout.currency },
                {
                    user: accounts[0].user,
                    currency: payout.currency,
                },
                {
                    upsert: true,
                    new: true,
                    rawResult: false,
                    useFindAndModify: false,
                },
            )
            if (!wallet)
            {
                await Promise.reject({ message: 'Wallet not found for user', code: RETRY_WEBHOOK_STATUS_CODE })
            }

            await session.withTransaction(async () =>
            {
                const newTxn = await PayoutTransaction.findOneAndUpdate(
                    {
                        user: accounts[0].user,
                        stripePayoutID: payout.id,
                        walletID: wallet.id
                    },
                    {
                        tax: 0,
                        status: TRANSACTION_STATUS.PENDING,
                        amount: payout.amount,
                        expectedDate: payout.arrival_date,
                        country: payout.country,
                        currency: payout.currency,
                        isBank: payout.type === 'card' ? false : true,
                        description: payout.description,
                        mask: payoutAccount.last4,
                        fingerprint: payoutAccount.fingerprint,
                        brand: payoutAccount.brand,
                        type: payoutAccount.type,
                        name: payoutAccount.name,
                        month: payoutAccount.month,
                        year: payoutAccount.year,
                        wallet: payoutAccount.wallet,
                        bankName: payoutAccount.bankName,
                        routingNumber: payoutAccount.routingNumber,
                    },
                    {
                        upsert: true,
                        new: true,
                        rawResult: false,
                        useFindAndModify: false,
                        session
                    }
                )

                await wallet.updateOne({
                    lastPayoutTransactionID: newTxn.id,
                    pendingPayout: wallet.pendingPayout + payout.amount
                }, { session })
            })
            await new Promise((resolve) =>
            {
                session.endSession(resolve)
            });
        } catch (e)
        {
            session.endSession()
            try
            {
                // TODO: the payout charge should be refunded
                await stripe.payouts.cancel(payout.id)
                console.log(`Canacelled payout ${payout.id} for ${account}`)
            } catch (e)
            {
                console.error(e)
                console.log(`Failed to cancel payout ${payout.id} for ${account}`)
            }
            throw e
        }
    }

    async payoutSuccess(account, payout)
    {
        const session = await mongoose.startSession()
        try
        {
            let accounts = await PaymentAccount.find({ stripeAccountID: account })
            if (accounts.length !== 1)
            {
                throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
            }

            // Get PayoutAccount
            const payoutAccount = await PayoutAccount.findOne({
                user: accounts[0].user,
                stripeExternalAccountID: payout.destination
            })
            if (!payoutAccount)
            {
                await Promise.reject({ message: 'External account not recognized', code: RETRY_WEBHOOK_STATUS_CODE })
            }

            // Get wallet
            const wallet = await Wallet.findOneAndUpdate({ user: accounts[0].user, currency: payout.currency },
                {
                    user: accounts[0].user,
                    currency: payout.currency,
                },
                {
                    upsert: true,
                    new: true,
                    rawResult: false,
                    useFindAndModify: false,
                },
            )
            if (!wallet)
            {
                await Promise.reject({ message: 'Wallet not found for user', code: RETRY_WEBHOOK_STATUS_CODE })
            }

            await session.withTransaction(async () =>
            {
                const newTxn = await PayoutTransaction.findOneAndUpdate(
                    {
                        user: accounts[0].user,
                        stripePayoutID: payout.id,
                        walletID: wallet.id
                    },
                    {
                        status: TRANSACTION_STATUS.SUCCESS,
                        amount: payout.amount,
                        expectedDate: payout.arrival_date,
                        country: payout.country,
                        currency: payout.currency,
                        isBank: payout.type === 'card' ? false : true,
                        description: payout.description,
                        mask: payoutAccount.last4,
                        fingerprint: payoutAccount.fingerprint,
                        brand: payoutAccount.brand,
                        type: payoutAccount.type,
                        name: payoutAccount.name,
                        month: payoutAccount.month,
                        year: payoutAccount.year,
                        wallet: payoutAccount.wallet,
                        bankName: payoutAccount.bankName,
                        routingNumber: payoutAccount.routingNumber,
                    },
                    {
                        upsert: true,
                        new: true,
                        rawResult: false,
                        useFindAndModify: false,
                        session
                    }
                )

                const balance = await stripe.balance.retrieve({ stripeAccount: account })
                const availableBalance = balance.available.reduce((prev, current) =>
                {
                    if (current.currency === payout.currency)
                    {
                        prev = prev + current.amount
                    }
                    return prev
                }, 0)

                await wallet.updateOne({
                    lastPayoutTransactionID: newTxn.id,
                    pendingPayout: wallet.pendingPayout - payout.amount,
                    value: availableBalance
                }, { session })
            })
            await new Promise((resolve) =>
            {
                session.endSession(resolve)
            });
        } catch (e)
        {
            session.endSession()
            throw e
        }
    }

    async payoutFailed(account, payout)
    {
        const session = await mongoose.startSession()
        try
        {
            let accounts = await PaymentAccount.find({ stripeAccountID: account })
            if (accounts.length !== 1)
            {
                throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
            }

            // Get PayoutAccount
            const payoutAccount = await PayoutAccount.findOne({
                user: accounts[0].user,
                stripeExternalAccountID: payout.destination
            })
            if (!payoutAccount)
            {
                throw new Error('External account not recognized')
            }

            // Get wallet
            const wallet = await Wallet.findOneAndUpdate({ user: accounts[0].user, currency: payout.currency },
                {
                    user: accounts[0].user,
                    currency: payout.currency,
                },
                {
                    upsert: true,
                    new: true,
                    rawResult: false,
                    useFindAndModify: false,
                },
            )
            if (!wallet)
            {
                // If no wallet, create one
                wallet = await Wallet.create({ user: accounts[0].user, currency: payout.currency })
            }

            await session.withTransaction(async () =>
            {
                // Stripe will deactivate accounts that failed to receive payout
                await payoutAccount.updateOne({ active: false })

                const newTxn = await PayoutTransaction.findOneAndUpdate(
                    {
                        user: accounts[0].user,
                        stripePayoutID: payout.id,
                        walletID: wallet.id
                    },
                    {
                        status: TRANSACTION_STATUS.FAILED,
                        amount: payout.amount,
                        expectedDate: payout.arrival_date,
                        country: payout.country,
                        currency: payout.currency,
                        isBank: payout.type === 'card' ? false : true,
                        description: payout.failure_message || payout.description,
                        mask: payoutAccount.last4,
                        fingerprint: payoutAccount.fingerprint,
                        brand: payoutAccount.brand,
                        type: payoutAccount.type,
                        name: payoutAccount.name,
                        month: payoutAccount.month,
                        year: payoutAccount.year,
                        wallet: payoutAccount.wallet,
                        bankName: payoutAccount.bankName,
                        routingNumber: payoutAccount.routingNumber,
                    },
                    {
                        upsert: true,
                        new: true,
                        rawResult: false,
                        useFindAndModify: false,
                        session
                    }
                )

                await wallet.updateOne({
                    lastPayoutTransactionID: newTxn.id,
                    pendingPayout: wallet.pendingPayout - payout.amount,
                    session
                })
            })
            await new Promise((resolve) =>
            {
                session.endSession(resolve)
            });
        } catch (e)
        {
            session.endSession()
            throw e
        }
    }

    async availableBalance(account, balance)
    {
        let accounts;

        try
        {
            const session = await mongoose.startSession()
            await session.withTransaction(async () =>
            {
                accounts = await PaymentAccount.find({ stripeAccountID: account })
                if (accounts?.length !== 1)
                {
                    throw new Error("Account must exist and you cannot have multiple accounts with same identity!")
                }

                console.log(`Started processing balance.available for ${accounts[0].user}`, balance)
                // Get wallet and update balances
                await Promise.all([
                    ...balance.available.map(async ({ currency, amount }) =>
                    {
                        await Wallet.findOneAndUpdate(
                            {
                                user: accounts[0].user,
                                currency
                            }, {
                            user: accounts[0].user,
                            value: amount,
                            currency
                        },
                            {
                                upsert: true,
                                new: true,
                                rawResult: false,
                                useFindAndModify: false,
                                session
                            }
                        )
                    }),
                    // Calculate the pending balances
                    ...balance.pending.map(async ({ currency, amount }) =>
                    {
                        await Wallet.findOneAndUpdate(
                            {
                                user: accounts[0].user,
                                currency
                            }, {
                            user: accounts[0].user,
                            pendingValue: amount,
                            currency
                        },
                            {
                                upsert: true,
                                new: true,
                                rawResult: false,
                                useFindAndModify: false,
                                session
                            }
                        )
                    }),
                ])
            })
            await new Promise((resolve) =>
            {
                session.endSession(resolve)
            });
            console.log(`Finished processing balance.available for ${accounts[0].user}`, balance)
        } catch (e)
        {
            session.endSession()
            return await Promise.reject({ message: e.message, status: e.status || e.statusCode || RETRY_WEBHOOK_STATUS_CODE })
        }
    }
}

module.exports = { Webhook }