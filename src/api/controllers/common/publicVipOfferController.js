const Package = require('../../models/common/Package');
const catchAsync = require('../../../utils/catchAsync');
const { currencyCode } = require('../../services/common/packagePricing');
const { YEAR_END_PACKAGE_ID, publicVipOffer } = require('../../services/common/yearEndVipOffer');
const { AppError, ErrorCodes } = require('../../../utils/AppError');

exports.getVipOffer = catchAsync(async (req, res, next) => {
  const currency = currencyCode(req.query.currency);
  if (!currency) return next(new AppError('Devise requise', 400, ErrorCodes.VALIDATION_ERROR));
  const pkg = await Package.findOne({
    _id: YEAR_END_PACKAGE_ID,
    isActive: true,
    paymentMode: { $in: ['money', null] },
  })
    .select('_id isActive paymentMode pricing economy duration categories availableOnGooglePlay googleProductId googleProductType')
    .populate('categories', 'isVip isActive')
    .lean();
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ success: true, data: { offer: publicVipOffer(pkg, currency) } });
});
