const { Payment, TRANSACTION_STATUS, RETRY_WEBHOOK_STATUS_CODE } = require('./payments');
const { Webhook } = require('./webhook')
const StripeWebhookEvent = require("../../../models/StripeWebhookEvent");
const PaymentAccount = require("../../../models/PaymentAccount");
const PayoutAccount = require("../../../models/PayoutAccount");
const PaymentTransaction = require("../../../models/PaymentTransaction");
const Wallet = require("../../../models/Wallet");
const PaymentMethod = require("../../../models/PaymentMethod");
const JobPayment = require("../../../models/JobPayment");
const { NIL } = require('uuid');
const mongoose = require('mongoose');
const { isActiveWallet, generateInvoiceAndSave } = require("../util");
const User = require("../../../models/User");
const { fireStore } = require('../../../config/firebase');
const Invoice = require("../../../models/Invoice");
const { calculateTax } = require('./tax');

const MOCK_TXS = [
  {
    _id: "151fd489-5898-4cb7-b691-62f649972d84",
    stripeCustomerID: "0619a5e7-0fa1-4f62-a4a8-2c67b0e8b205",
    stripeAccountID: "26eb72cc-3d9d-4c38-9bd5-e2ddde5e00d3",
    user: "632686c6a15add7d90e36989",
    sender: "632720216c261e3c5e30b556",
    status: 1,
    tax: 10,
    serviceCharge: 250,
    mobilizationFee: 30,
    deployeeRevenue: 50,
    amount: 38000,
    description: "test job",
    name: "John Doe",
    currency: "usd",
    country: "Nigeria",
    stripePaymentIntentID: "632720216c261e3c5e30b556",
    stripeInvoiceID: "632720216c261e3c5e30b556",
    mask: "4444",
    fingerprint: "632720216c261e3c5e30b556",
    type: "card",
    brand: "mastercard",
    month: "12",
    year: "24",
    wallet: "63268be012fca1b0a7540605",
    dateCreated: "2022-09-18T15:13:16.395+00:00",
  },
  {
    _id: "467f15bc-955e-43b6-b4e0-decfff117fea",
    stripeCustomerID: "0619a5e7-0fa1-4f62-a4a8-2c67b0e8b205",
    stripeAccountID: "26eb72cc-3d9d-4c38-9bd5-e2ddde5e00d3",
    user: "632686c6a15add7d90e36989",
    sender: "632720216c261e3c5e30b556",
    status: 1,
    tax: 10,
    serviceCharge: 250,
    mobilizationFee: 30,
    deployeeRevenue: 50,
    amount: 4500,
    description: "test job",
    name: "Johanna Doe",
    currency: "usd",
    country: "Nigeria",
    stripePaymentIntentID: "632720216c261e3c5e30b556",
    stripeInvoiceID: "632720216c261e3c5e30b556",
    mask: "4444",
    fingerprint: "632720216c261e3c5e30b556",
    type: "card",
    brand: "mastercard",
    month: "12",
    year: "24",
    wallet: "63268be012fca1b0a7540605",
    dateCreated: "2022-09-18T15:13:16.395+00:00",
  },
  {
    _id: "9ffb3326-b7e2-4959-bff5-032e557cd074",
    stripeCustomerID: "0619a5e7-0fa1-4f62-a4a8-2c67b0e8b205",
    stripeAccountID: "26eb72cc-3d9d-4c38-9bd5-e2ddde5e00d3",
    user: "632686c6a15add7d90e36989",
    sender: "632720216c261e3c5e30b556",
    status: 1,
    tax: 10,
    serviceCharge: 250,
    mobilizationFee: 30,
    deployeeRevenue: 50,
    amount: 9000,
    description: "test job",
    name: "Jane Doe",
    currency: "usd",
    country: "Nigeria",
    stripePaymentIntentID: "632720216c261e3c5e30b556",
    stripeInvoiceID: "632720216c261e3c5e30b556",
    mask: "4444",
    fingerprint: "632720216c261e3c5e30b556",
    type: "card",
    brand: "mastercard",
    month: "12",
    year: "24",
    wallet: "63268be012fca1b0a7540605",
    dateCreated: "2022-09-18T15:13:16.395+00:00",
  },
];

function calculateStripeFee(amount) {
  if (amount < 5000) {
    // For jobs less than $50, charge $2.50 mobilization fee
    return 250
  } else {
    // For jobs greater than or equal to $50, charge $4.50 mobilization fee
    return 450
  }
}

exports.create_setup_intent = async (req, res) => {
  try {
    // Create or use an existing Customer to associate with the SetupIntent.
    // The PaymentMethod will be stored to this Customer for later use.
    const user = req.userData.userId
    // Get user's account
    let account = await PaymentAccount.findOne({ user })
    if (!account || !account.stripeCustomerID) {
      // Create a new account for this user
      let customer = await Payment.createCustomer({
        last_name: req.body.last_name,
        first_name: req.body.first_name,
        email: req.userData.email?.trim(),
        phone: req.userData.phone_number,
      })

      account = await PaymentAccount.create({ user, isOnboarded: false, stripeCustomerID: customer.id })
    }

    const checkout = await Payment.createSetupCheckoutSession(account.stripeCustomerID)

    return res.send({ sessionID: checkout.id, });
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.initiateAccount = async (req, res) => {
  // Create or use an existing Customer to associate with the SetupIntent.
  // The PaymentMethod will be stored to this Customer for later use.
  const user = req.userData.userId

  try {
    // Get user's account
    let account = await PaymentAccount.findOne({ user })
    if (!account) {
      // Create a new account for this user
      const customer = await Payment.createCustomer({
        last_name: req.body.last_name,
        first_name: req.body.first_name,
        email: req.userData.email?.trim(),
        phone: req.userData.phone_number,
      })
      const stripeAccount = await Payment.createAccount({
        last_name: req.body.last_name,
        first_name: req.body.first_name,
        email: req.userData.email,
      })

      account = await PaymentAccount.create({ user, isOnboarded: false, stripeCustomerID: customer.id, stripeAccountID: stripeAccount.id })
    } else if (!account.stripeAccountID) {
      const stripeAccountNew = await Payment.createAccount({
        last_name: req.body.last_name,
        first_name: req.body.first_name,
        email: req.userData.email?.trim(),
      })

      account = await account.updateOne({ isOnboarded: false, stripeAccountID: stripeAccountNew.id }, { new: true })
    }

    const url = await Payment.generateAccountLink(account.stripeAccountID)

    return res.send({ url });
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.getLoginLink = async (req, res) => {
  const user = req.userData.userId

  try {
    // Get user's account
    let account = await PaymentAccount.findOne({ user, isOnboarded: true, payoutEnabled: true })
    if (!account) {
      throw new Error('You must have an existing account to continue')
    }

    const url = await Payment.generateDashboardLink(account.stripeAccountID)

    return res.send({ url });
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.getInfo = async (req, res) => {
  try {
    const { userId: user, role } = req.userData
    const result = {
      balance: 0,
      defaultMethod: null,
      hasActiveAccount: false,
      hasAccount: false,
      suspended: false,
      externalAccounts: [],
      methods: [],
      transactions: []
    }
    // Get user's account
    let account = await PaymentAccount.findOne({ user })
    if (account) {
      result.hasActiveAccount = account.isOnboarded && account.payoutEnabled
      result.hasAccount = Boolean(account.stripeAccountID)
    }

    if (role === 'contractor') {
      const wallet = await Wallet.findOneAndUpdate({ user, currency: 'usd' },
        {
          user,
          currency: 'usd',
        },
        {
          upsert: true,
          new: true,
          rawResult: false,
          useFindAndModify: false,
        },
      )
      if (wallet) {
        result.balance = wallet.value
        result.suspended = !(await isActiveWallet(wallet))
      }
    }

    // TODO: paginate
    // let txns = await PaymentTransaction.find({
    //   $or: [
    //     { sender: user },
    //     {
    //       user,
    //       status: TRANSACTION_STATUS.SUCCESS
    //     },
    //   ]
    // }).sort('-dateCreated')
    // result.transactions = txns.map((data) => {
    //   const inbound = data.user === user;

    //   const {
    //     _id: id, invoiceURL, dateCreated, name, wallet, year, month, deployeeRevenue,
    //     brand, mask, amount, status, description, tax, serviceCharge, mobilizationFee,
    //   } = data.toObject()

    //   return { id, invoiceURL, dateCreated, name, wallet, year, month, brand, mask, amount, status, description, tax, serviceCharge, mobilizationFee, inbound, deployeeRevenue }
    // })
    result.transactions = MOCK_TXS.map((data) => {
      const inbound = data.user === user;

      const {
        _id: id, invoiceURL, dateCreated, name, wallet, year, month, deployeeRevenue,
        brand, mask, amount, status, description, tax, serviceCharge, mobilizationFee,
      } = data;

      return { id, invoiceURL, dateCreated, name, wallet, year, month, brand, mask, amount, status, description, tax, serviceCharge, mobilizationFee, inbound, deployeeRevenue }
    })

    let extAccounts = await PayoutAccount.find({ user }).sort('-dateCreated')
    result.externalAccounts = extAccounts.map((data) => {
      const { _id: id, routingNumber, dateCreated, name, wallet, year, month, brand, mask, active, isBank, bankName, currency, type } = data.toObject()
      return { id, dateCreated, name, routingNumber, wallet, year, month, brand, mask, active, isBank, bankName, currency, type }
    })

    let methods = await PaymentMethod.find({ user }).sort('-dateCreated')
    result.methods = methods.map(({ id, dateCreated, name, isDefault, wallet, year, month, brand, mask }) => {
      return { id, dateCreated, name, wallet, year, month, isDefault, brand, mask }
    })

    return res.send(result);
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.webGetTransactionHistory = async (req, res) => {
  try {
    const { userId: user, role } = req.userData
    let { page, limit } = req.query

    if (role === 'contractor') {
      await Promise.reject({ status: 401, message: 'Permission denied' })
    }

    page = parseInt(page, 10)
    limit = parseInt(limit, 10)
    if (!page || page < 1 || !limit || limit < 1) {
      throw new Error('Invalid data range provided')
    }

    let query

    if (role === 'admin') {
      query = { status: { $in: [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.UNCAPTURED, TRANSACTION_STATUS.SUCCESS] } }
    } else {
      query = {
        $or: [
          {
            sender: user,
            status: { $in: [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.UNCAPTURED, TRANSACTION_STATUS.SUCCESS] }
          },
          {
            user,
            status: { $in: [TRANSACTION_STATUS.SUCCESS] }
          }
        ]
      }
    }
    const transactions = await PaymentTransaction.find(query,
      '_id user sender status amount description dateCreated',
      {
        limit,
        skip: (page - 1) * 30,
        sort: '-dateCreated'
      })

    const result = (await Promise.all(transactions.map(async (data) => {
      try {
        const jobPayment = await JobPayment.findOne({ paymentID: data.id }, 'jobID')
        if (jobPayment) {
          data.jobID = jobPayment.jobID
          // Get the job title
          // TODO: This should be stored in the JobPayment database to aid easy fetching
          const jobSnap = await fireStore.doc(`jobs/${data.jobID}`).get()
          if (jobSnap.exists) {
            data.title = jobSnap.data().job_title
          } else {
            data.title = 'Untitled Job'
          }
        } else {
          console.log(data)
          throw new Error('No data available')
        }

        const userData = await User.findById(data.user, 'first_name last_name')
        if (userData) {
          data.user = `${userData.first_name} ${userData.last_name}`
        } else {
          throw new Error('User not found')
        }

        return data
      } catch (e) {
        console.log(`Failed to fetch additional details for payment transaction ${data.id}`, e)
        return null
      }
    }))).filter(txn => !!txn)

    return res.send(result);
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.webGetInvoices = async (req, res) => {
  try {
    const { userId: user, role } = req.userData
    let { page, limit } = req.query

    if (!role || role === 'contractor') {
      await Promise.reject({ status: 401, message: 'Permission denied' })
    }

    page = parseInt(page, 10)
    limit = parseInt(limit, 10)
    if (!page || page < 1 || !limit || limit < 1) {
      throw new Error('Invalid data range provided')
    }

    let query = {}

    if (role === 'project_manager') {
      query = { user }
    }
    const invoices = await Invoice.find(query, undefined, {
      limit,
      skip: (page - 1) * 30,
      sort: '-dateCreated'
    })

    const total = await new Promise((res, rej) => {
      Invoice.count(query, (err, count) => {
        if (err) {
          return rej(err)
        }
        res(count)
      })
    })
    return res.send({ invoices, total });
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.deleteMethod = async (req, res) => {
  try {
    const user = req.userData.userId

    let deleted = await PaymentMethod.findOne({ _id: req.body.method, user })
    if (deleted) {
      // Check for any uncaptured funds on card
      const existingTxn = await PaymentTransaction.find({ fingerprint: deleted.fingerprint, status: TRANSACTION_STATUS.UNCAPTURED })

      if (existingTxn && existingTxn.length > 0) {
        throw new Error('Cannot delete method as it is currently linked to an active job')
      }
      await Payment.deletePaymentMethod(deleted.stripePaymentMethodID)
      let success = await deleted.delete()
      if (!success) {
        throw new Error('Method not found')
      }
      return res.send({ message: 'Succesful', success: true });
    }
    throw new Error('Method not found')
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.chargeCheckrFee = async (req, res) => {
  try {
    const user = req.userData.userId
    const { amount, paymentMethodID } = req.body
    if (!amount || !user || !paymentMethodID) {
      throw new Error('You have to provide all necessary details to continue with payment')
    }

    const paymentMethod = await PaymentMethod.findById(paymentMethodID)
    if (!paymentMethod || user !== paymentMethod.user) {
      throw new Error('Payment method not found')
    }

    let accounts = await PaymentAccount.find({ user })
    if (accounts.length !== 1 || !accounts[0].stripeCustomerID) {
      console.log(`duplicate account found for: ${user}`, accounts)
      throw new Error("Cannot continue as duplicate accounts were found")
    }

    const paymentIntent = await Payment.makePayment({
      customer: accounts[0].stripeCustomerID,
      amount: amount + computedFee,
      payment_method: paymentMethod.stripePaymentMethodID,
      description: `Checkr Background Check Payment for ${process.env.APP_NAME}`
    })

    const txn = await PaymentTransaction.create({
      stripeCustomerID: accounts[0].stripeCustomerID,
      user: NIL,
      sender: user,
      status: TRANSACTION_STATUS.PENDING,
      amount: paymentIntent.amount,
      description,
      name: paymentMethod.name,
      currency: paymentIntent.currency,
      country: paymentMethod.country,
      stripePaymentIntentID: paymentIntent.id,
      mask: paymentMethod.mask,
      fingerprint: paymentMethod.fingerprint,
      type: paymentMethod.type,
      brand: paymentMethod.brand,
      month: paymentMethod.month,
      year: paymentMethod.year,
      wallet: paymentMethod.wallet,
    })

    return res.send({ message: 'Successful', paymentID: txn.id });
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.makePaymentForJob = async (req, res) => {
  try {
    const user = req.userData.userId
    const role = req.userData.role
    const { amount, description, jobID, paymentMethodID, recipient } = req.body
    if (!amount || !user || !description || !jobID || !paymentMethodID) {
      throw new Error('You have to provide all necessary details to continue with payment')
    }
    const userDetails = await User.findById(user, "state");
    if (!userDetails) {
      throw new Error('User not found')
    }

    const computedFee = calculateStripeFee(amount)
    // This is the percentage of the bill amount that will be charged on the deployee and deployer.
    // The deployer will pay the extra, while the calculated sum will be deducted before sending to the deployee
    const calculatedPercentage = Math.ceil(amount * 0.125);
    const deployerFee = computedFee + calculatedPercentage;
    const deployeeFee = computedFee + calculatedPercentage;

    const tax = calculateTax(amount, userDetails.state)

    const paymentMethod = await PaymentMethod.findById(paymentMethodID)
    if (!paymentMethod || user !== paymentMethod.user) {
      throw new Error('Cannot accept job as there is no payment method avaiable')
    }

    let accounts = await PaymentAccount.find({ user })
    if (accounts.length !== 1 || !accounts[0].stripeCustomerID) {
      console.log(`duplicate account found for: ${user}`, accounts)
      throw new Error("Cannot continue as duplicate accounts were found")
    }

    let recipientAccount = await PaymentAccount.findOne({ user: recipient })
    if (!recipientAccount || !recipientAccount.stripeAccountID) {
      throw new Error(role === 'contractor' ? "Complete setting up your account details and try again" : "Cannot make payment to this recipient!")
    }

    // The deployerFee (Surcharge on payment) will be sent to the application.
    // The deployee will also be charged a corresponding amount, which will be sent to the application.
    const applicationFee = deployerFee + deployeeFee + tax;
    const paymentIntent = await Payment.makeAccountPayment({
      accountID: recipientAccount.stripeAccountID,
      customer: accounts[0].stripeCustomerID,
      amount: amount + deployerFee + tax,
      payment_method: paymentMethod.stripePaymentMethodID,
      applicationFee,
      description
    })

    const txn = await PaymentTransaction.create({
      stripeCustomerID: accounts[0].stripeCustomerID,
      stripeAccountID: recipientAccount.stripeAccountID,
      user: recipientAccount.user,
      sender: user,
      status: TRANSACTION_STATUS.PENDING,
      amount: paymentIntent.amount,
      description,
      name: paymentMethod.name,
      currency: paymentIntent.currency,
      country: paymentMethod.country,
      stripePaymentIntentID: paymentIntent.id,
      mask: paymentMethod.mask,
      fingerprint: paymentMethod.fingerprint,
      type: paymentMethod.type,
      brand: paymentMethod.brand,
      month: paymentMethod.month,
      year: paymentMethod.year,
      wallet: paymentMethod.wallet,
      serviceCharge: calculatedPercentage,
      mobilizationFee: computedFee,
      deployeeRevenue: amount - deployeeFee,
      tax,
    })

    await JobPayment.create({
      paymentID: txn.id,
      // This  is the original amount without the service cost and mobilization fee
      amount,
      jobID,
      tax,
      deployerCharge: deployerFee,
      applicationFee,
      description
    })

    return res.send({
      message: 'Successful',
      transaction: {
        id: txn._id, invoiceURL: txn.invoiceURL,
        dateCreated: txn.dateCreated, name: txn.name,
        wallet: txn.wallet, year: txn.year,
        month: txn.month, brand: txn.brand, mask: txn.mask,
        amount: txn.amount, status: txn.status, description: txn.description
      }
    });
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.cancelAuthorizedPayment = async (req, res) => {
  try {
    const user = req.userData.userId
    const { transactionID } = req.body

    if (!transactionID) {
      throw new Error('You have to provide all necessary details to continue with payment')
    }

    console.log(`About to cancel authorized funds for ${user}`)

    let txn = await PaymentTransaction.findOne(
      { _id: transactionID, sender: user, status: TRANSACTION_STATUS.UNCAPTURED },
    )
    if (!txn) {
      throw new Error("Cannot find transaction!")
    }

    await Payment.cancelAuthorizedPayment(txn.stripePaymentIntentID)
    await txn.updateOne({ status: TRANSACTION_STATUS.DECLINED })

    if (req.callback) {
      await req.callback()
    }

    return res.send({
      message: 'Successful',
      transaction: {
        id: txn._id, invoiceURL: txn.invoiceURL,
        dateCreated: txn.dateCreated, name: txn.name,
        wallet: txn.wallet, year: txn.year,
        month: txn.month, brand: txn.brand, mask: txn.mask,
        amount: txn.amount, status: txn.status, description: txn.description
      }
    });
  } catch (e) {
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.authorizePaymentForJob = async (req, res) => {
  let paymentIntent = false
  const user = req.userData.userId
  const role = req.userData.role
  const { callback, errorCallback, body: { recipient,
    amount,
    description,
    jobID,
    title,
    location,
    deployee
  } } = req

  const session = await mongoose.startSession()

  try {
    if (!amount || !recipient || !description || !jobID) {
      throw new Error('You have to provide all necessary details to continue with payment')
    }
    const userDetails = await User.findById(user, "state");
    if (!userDetails) {
      throw new Error('User not found')
    }

    const computedFee = calculateStripeFee(amount)
    // This is the percentage of the bill amount that will be charged on the deployee and deployer.
    // The deployer will pay the extra, while the calculated sum will be deducted before sending to the deployee
    const calculatedPercentage = Math.ceil(amount * 0.125);
    const deployerFee = computedFee + calculatedPercentage;
    const deployeeFee = computedFee + calculatedPercentage;

    const tax = calculateTax(amount, userDetails.state)

    // For authorized payment, the default payment method will be charged
    const paymentMethod = await PaymentMethod.findOne({ user, isDefault: true })
    if (!paymentMethod) {
      throw new Error('Payment method not found')
    }

    let accounts = await PaymentAccount.find({ user })
    if (accounts.length !== 1 || !accounts[0].stripeCustomerID) {
      console.log(`duplicate account found for: ${user}`, accounts)
      throw new Error("Cannot continue as duplicate accounts were found")
    }

    let recipientAccount = await PaymentAccount.findOne({ user: recipient })
    if (!recipientAccount || !recipientAccount.stripeAccountID) {
      throw new Error(role === 'contractor' ? "Complete setting up your account details and try again" : "Cannot make payment to this recipient!")
    }

    let txn

    await session.withTransaction(async (session) => {
      // The deployerFee (Surcharge on payment) will be sent to the application.
      // The deployee will also be charged a corresponding amount, which will be sent to the application.
      const applicationFee = deployerFee + deployeeFee + tax;
      paymentIntent = await Payment.authorizeFundsForPayment({
        accountID: recipientAccount.stripeAccountID,
        customer: accounts[0].stripeCustomerID,
        amount: amount + deployerFee + tax,
        payment_method: paymentMethod.stripePaymentMethodID,
        applicationFee,
        description
      })

      const [_txn] = await PaymentTransaction.create([{
        stripeCustomerID: accounts[0].stripeCustomerID,
        stripeAccountID: recipientAccount.stripeAccountID,
        user: recipient,
        sender: user,
        status: TRANSACTION_STATUS.UNCAPTURED,
        amount: paymentIntent.amount,
        description,
        /**
         * This is the beneficiary account or cardholder name
         */
        name: paymentMethod.name,
        currency: paymentIntent.currency,
        country: paymentMethod.country,
        stripePaymentIntentID: paymentIntent.id,
        mask: paymentMethod.mask,
        fingerprint: paymentMethod.fingerprint,
        type: paymentMethod.type,
        brand: paymentMethod.brand,
        month: paymentMethod.month,
        year: paymentMethod.year,
        wallet: paymentMethod.wallet,
        serviceCharge: calculatedPercentage,
        mobilizationFee: computedFee,
        deployeeRevenue: amount - deployeeFee,
        tax,
      }], { session })

      await JobPayment.findOneAndUpdate({ jobID },
        {
          paymentID: _txn.id,
          // This  is the original amount without the service cost and mobilization fee
          amount,
          jobID,
          tax,
          deployerCharge: deployerFee,
          applicationFee,
          description,
        }, {
        upsert: true,
        useFindAndModify: false,
        session
      })

      const [secs, nano] = process.hrtime()
      const invoiceDate = new Date()

      const invoiceData = {
        user,
        invoiceReference: `${invoiceDate.getFullYear()}${invoiceDate.getMonth()}${invoiceDate.getDay()}${invoiceDate.getSeconds()}${invoiceDate.getMilliseconds()}${secs}${nano}`,
        transactionID: _txn.id,
        jobStatus: 'Pending',
        description: _txn.description,
        jobTitle: title,
        location,
        deployee,
        tax,
        amount: amount - tax - deployerFee,
        fees: deployerFee,
        total: _txn.amount,
        paymentMethod: `${paymentMethod.brand} **** ${paymentMethod.mask} EXP: ${paymentMethod.month}.${paymentMethod.year}`
      }
      const savedFile = await generateInvoiceAndSave(invoiceData)
      invoiceData.invoiceURL = savedFile.Location
      await Invoice.create([invoiceData], { session })

      if (callback) {
        await callback()
      }

      txn = _txn
    })
    await new Promise((resolve) => {
      session.endSession(resolve)
    });

    return res.send({
      message: 'Successful',
      transaction: {
        id: txn._id, invoiceURL: txn.invoiceURL,
        dateCreated: txn.dateCreated, name: txn.name,
        wallet: txn.wallet, year: txn.year,
        month: txn.month, brand: txn.brand, mask: txn.mask,
        amount: txn.amount, status: txn.status, description: txn.description
      }
    })
  } catch (e) {
    console.error(e)
    if (errorCallback) {
      errorCallback()
    }
    console.log("Payment authorization failed", paymentIntent)
    if (paymentIntent) {
      try {
        await Payment.cancelAuthorizedPayment(paymentIntent.id)
      } catch (e) {
        console.log(`Failed to cancel authorized payment ${paymentIntent.id}`, e)
      }
    }
    session.endSession()
    return res.status(e.statusCode || e.status || 500).json({ message: "Payment authorization failed" });
  }
};

exports.capturePaymentForJob = async (req, res) => {
  const session = await mongoose.startSession()

  try {
    const user = req.userData.userId
    let { capturedCallback, body: { amount, jobID, transactionID, cancelled } } = req

    await session.withTransaction(async () => {

      const userDetails = await User.findById(user, "state");
      if (!userDetails) {
        throw new Error('User not found')
      }

      console.log(`About to capture funds for ${user}`)

      if (!jobID || !transactionID) {
        throw new Error('You have to provide all necessary details to continue with payment')
      }
      let txn = await PaymentTransaction.findOne({ _id: transactionID, sender: user, status: TRANSACTION_STATUS.UNCAPTURED })
      if (!txn) {
        throw new Error("Cannot find transaction")
      }


      const jobPayment = await JobPayment.findOne({ jobID, paymentID: txn.id })
      if (!jobPayment) {
        throw new Error('Job payment not found')
      }

      let tax = txn.tax;
      let applicationFee = jobPayment.applicationFee
      if (amount && amount !== txn.amount) {
        // Recalculate tax
        tax = calculateTax(amount, userDetails.state);
        // Recalculate application fee based on new tax
        applicationFee = (applicationFee - txn.tax) + tax
        amount = amount + jobPayment.deployerCharge + tax;
      } else {
        amount = txn.amount
      }
      const description = cancelled ? `CANCELLED - ${txn.description}` : txn.description
      await txn.updateOne({
        amount,
        description,
        tax,
        deployeeRevenue: amount - applicationFee,
        status: TRANSACTION_STATUS.PENDING,
      }, { session })

      // The service charge remains same even if the money is not paid in full
      await Payment.captureforPayment(txn.stripePaymentIntentID, { amount, applicationFee, })
    })
    await new Promise((resolve) => {
      session.endSession(resolve)
    });

    if (capturedCallback) {
      await capturedCallback()
    }
    return res.send({ message: 'Successful' })
  } catch (e) {
    session.endSession()
    console.log("Payment capture failed")
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: "Payment capture failed" });
  }
};

// TODO: there should be a session storage mechanism to prevent security attacks, such as CSRF as these endpoints are sensitive
exports.payout = async (req, res) => {
  try {
    const user = req.userData.userId
    const { amount, destination, currency = 'usd' } = req.body

    if (!amount || !destination) {
      throw new Error('You have to provide all necessary details to continue with payout')
    }

    let accounts = await PaymentAccount.find({ user })
    if (accounts.length !== 1 || !accounts[0].stripeAccountID) {
      throw new Error("Account must exist and you cannot have multiple accounts")
    }

    console.log(`Initiating payout for ${user}`)

    let payoutAccount = await PayoutAccount.findOne({ _id: destination, user })
    if (!payoutAccount) {
      throw new Error("Cannot find payout destination")
    } else if (!payoutAccount.active) {
      throw new Error("Payout destination is inactive")
    }

    await Payment.payout({
      account: accounts[0].stripeAccountID,
      destination: payoutAccount.stripeExternalAccountID,
      isBank: payoutAccount.isBank,
      user,
      amount,
      currency
    })

    return res.send({ message: 'Successful' });
  } catch (e) {
    console.log("Payout failed")
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.setDefault = async (req, res) => {
  const user = req.userData.userId
  const session = await mongoose.startSession()

  try {
    // Get user's account
    let account = await PaymentAccount.findOne({ user })
    if (!account) {
      throw new Error('Account does not exist')
    }

    let method = await PaymentMethod.findOne({ _id: req.body.method, user })
    if (method) {
      await session.withTransaction(async () => {
        await Payment.setDefaultPaymentMethod(method.stripePaymentMethodID, account.stripeCustomerID)

        await method.update({ isDefault: true }, { session })
        await PaymentMethod.updateMany({ user, _id: { $ne: method.id } },
          { isDefault: false },
          { session })
      })
      await new Promise((resolve) => {
        session.endSession(resolve)
      });

      return res.send({ message: 'Succesful', success: true });
    }
    throw new Error('Method not found')
  } catch (e) {
    session.endSession()
    console.error(e)
    return res.status(e.statusCode || e.status || 500).json({ message: e.message });
  }
};

exports.webhookEntry = async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];

    if (!sig) {
      throw new Error("Unverifiable data provided");
    }

    let response = await handleEvent(req.body, sig);
    res.status(200).send(response);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).send({
      error: err.message || "There was an error while calling webhook",
    });
  }
};

exports.webhookConnectEntry = async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];

    if (!sig) {
      throw new Error("Unverifiable data provided");
    }

    const webhookSecret = process.env.NODE_ENV === 'production' ? process.env.STRIPE_ENDPOINT_SECRET_CONNECT : process.env.STRIPE_ENDPOINT_SECRET_DEV
    let response = await handleEvent(req.body, sig, webhookSecret);
    res.status(200).send(response);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).send({
      error: err.message || "There was an error while calling webhook",
    });
  }
};

const handleEvent = async (event, sig, secret = undefined) => {
  const instance = new Webhook(event, sig, secret);
  if (!Webhook.acceptedEvents.find((ev) => ev === instance.event.type)) {
    // The event type received is not supported by this application.
    // Return a successful response code to prevent Stripe from retrying request.
    // In future, the required events hsould be specified on stripe.
    return Promise.reject({ message: "Event type not supported", id: instance.event.id, type: instance.event.type, status: 200 });
  }

  if (process.env.NODE_ENV !== 'development' && (process.env.STRIPE_ENDPOINT_ALLOW_TEST_MODE === 'no' && !instance.event.livemode) && instance.event.account) {
    // If the application is in production and a test connect event is sent, reject the event processing.
    // Ideally, test events should be handled separately from the live data.
    return Promise.reject({ message: "Cannot cross environments", id: instance.event.id, type: instance.event.type, status: 200 });
  }

  // Check if event has been called previously then log the new event.
  const existingWebhookEvent = await StripeWebhookEvent.findOne({
    type: instance.event.type,
    eventID: instance.event.id,
  });

  if (existingWebhookEvent) {
    // TODO: check if transaction has been completed
    // return Promise.reject({ message: 'Duplicate event!', eventID: instance.event.id, status: 204 })
  }

  console.log(instance.event.type, "webhook event listener");

  const newEventLog = await StripeWebhookEvent.findOneAndUpdate(
    {
      type: instance.event.type,
      eventID: instance.event.id,
    },
    {
      eventID: instance.event.id,
      type: instance.event.type,
      source: "stripe",
    },
    {
      upsert: true,
      new: true,
      useFindAndModify: false
    });

  let result;

  // TODO: Test if balances for wallets are triggered for each payment intent
  try {
    result = await instance.handle();
  } catch (e) {
    console.error(e)
    if (e.status === RETRY_WEBHOOK_STATUS_CODE) {
      // Fail-safe for when the process exited but we expect Stripe to trigger this webhook again in future.
      // If the log is not deleted, future events will be dropped
      newEventLog.delete()
    }
    throw e;
  }

  return Promise.resolve(result);
};
