import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const RazorpayOrder = sequelize.define('RazorpayOrder', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    order_id: {
      type: DataTypes.STRING(128),
      allowNull: false,
      unique: true
    },
    bundle_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'razorpay_orders',
    timestamps: false,
    indexes: [
      { unique: true, fields: ['order_id'] },
      { fields: ['bundle_id'] },
      { fields: ['user_id'] }
    ]
  });

  return RazorpayOrder;
};


