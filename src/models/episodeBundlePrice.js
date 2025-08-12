import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const EpisodeBundlePrice = sequelize.define('EpisodeBundlePrice', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    bundle_name: {
      type: DataTypes.STRING
    },
    productId: {
      type: DataTypes.STRING
    },
    productName: {
      type: DataTypes.STRING
    },
    bundle_count: {
      type: DataTypes.INTEGER
    },
    price_points: {
      type: DataTypes.INTEGER
    },
    appleproductid: {
      type: DataTypes.STRING
    },
    appleprice: {
      type: DataTypes.INTEGER
    },
    is_popular: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'episode_bundle_prices',
    timestamps: false
  });

  return EpisodeBundlePrice;
}; 