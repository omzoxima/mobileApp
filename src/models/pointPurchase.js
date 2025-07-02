import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const PointPurchase = sequelize.define('PointPurchase', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    user_id: {
      type: DataTypes.UUID,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    pack_id: {
      type: DataTypes.STRING
    },
    platform: {
      type: DataTypes.STRING
    },
    points: {
      type: DataTypes.INTEGER
    },
    price: {
      type: DataTypes.DECIMAL
    },
    transaction_id: {
      type: DataTypes.STRING
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'point_purchases',
    timestamps: false
  });

  return PointPurchase;
};